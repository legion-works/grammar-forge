//go:build cgo && ORT

// Package gector runs the GECToR ONNX model in-process via hugot and implements
// correction.Corrector. One hugot Session is held for the process lifetime.
// Build with -tags ORT.
package gector

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/knights-analytics/hugot"
	"github.com/knights-analytics/hugot/backends"
	"github.com/knights-analytics/hugot/options"
	"github.com/knights-analytics/hugot/pipelines"
)

// GECToR is a process-wide ONNX Corrector. Build with -tags ORT.
type GECToR struct {
	mu       sync.Mutex
	session  *hugot.Session
	pipeline *pipelines.TokenClassificationPipeline
	vocab    VerbVocab
}

// VerbVocab maps (currentToken, fromToTag) -> targetToken. It is loaded from
// the optional `<modelDir>/verb-form-vocab.txt` (gector's standard
// verb-form vocabulary). When absent or empty, $TRANSFORM_VERB_* tags
// gracefully degrade to "no change" (counted in decodeToSuggestions's skip
// return so callers can log it).
type VerbVocab map[string]map[string]string

// New loads the INT8 ONNX model + tokenizer from modelDir. The ONNX runtime
// library path is taken from $GF_ORT_LIB_DIR (default /usr/local/lib for the
// container image; bridge/native during local dev).
func New(modelDir string) (*GECToR, error) {
	ortDir := os.Getenv("GF_ORT_LIB_DIR")
	if ortDir == "" {
		ortDir = "/usr/local/lib"
	}
	sess, err := hugot.NewORTSession(context.Background(), options.WithOnnxLibraryPath(ortDir))
	if err != nil {
		return nil, fmt.Errorf("hugot session: %w", err)
	}
	cfg := backends.PipelineConfig[*pipelines.TokenClassificationPipeline]{
		Name:      "gector",
		ModelPath: modelDir,
		Options: []backends.PipelineOption[*pipelines.TokenClassificationPipeline]{
			pipelines.WithoutAggregation(), // we group subwords ourselves
		},
	}
	pipe, err := hugot.NewPipeline[*pipelines.TokenClassificationPipeline](sess, cfg)
	if err != nil {
		_ = sess.Destroy()
		return nil, fmt.Errorf("gector pipeline: %w", err)
	}
	vocab, err := loadVerbVocab(modelDir + "/verb-form-vocab.txt")
	if err != nil {
		// non-fatal: decode degrades gracefully (no verb-form corrections)
		vocab = VerbVocab{}
	}
	return &GECToR{session: sess, pipeline: pipe, vocab: vocab}, nil
}

// Close releases the ONNX session.
func (g *GECToR) Close() error { return g.session.Destroy() }

// Name reports the model tag.
func (g *GECToR) Name() correction.Model { return correction.ModelGECToR }

// Correct runs one GECToR pass and returns per-word Suggestions. Each non-KEEP
// word emits one Suggestion whose confidence is the per-token softmax score
// from the underlying hugot entity. The first pass is sufficient for the
// common GECToR-tagged edits (subject-verb agreement, replace, delete, case);
// multi-pass is intentionally not run because it would obscure the per-edit
// confidence we surface to clients.
func (g *GECToR) Correct(ctx context.Context, req correction.Request) ([]correction.Suggestion, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	out, err := g.pipeline.RunPipeline(ctx, []string{req.Text})
	if err != nil {
		return nil, fmt.Errorf("gector inference: %w", err)
	}
	if len(out.Entities) == 0 {
		return nil, nil
	}
	return decodeToSuggestions(req.Text, out.Entities[0], g.vocab)
}

// wordBoundaryChar is the prefix the GECToR (DeBERTa-v1) tokenizer prepends to
// subwords that begin a new word. It is U+0120 (Ġ). The spike also accepts the
// sentencepiece "▁" (U+2581) variant for safety.
const (
	wordBoundaryChar = "\u0120"
	altBoundaryChar  = "\u2581"
)

// stripBoundary removes the leading boundary marker (Ġ or ▁) and reports
// whether the original subword carried the marker.
func stripBoundary(s string) (string, bool) {
	switch {
	case strings.HasPrefix(s, wordBoundaryChar):
		return strings.TrimPrefix(s, wordBoundaryChar), true
	case strings.HasPrefix(s, altBoundaryChar):
		return strings.TrimPrefix(s, altBoundaryChar), true
	}
	return s, false
}

// decodeToSuggestions groups the per-subword entities into words (using the
// Ġ/▁ boundary marker), applies the first subword's GECToR tag to each word,
// and emits a Suggestion per non-KEEP word. Each suggestion's confidence is
// the first subword's softmax Score (the per-token tag probability from the
// model). Verb-form transforms are looked up in vocab; misses are skipped
// (counted and logged) so a missing/unmapped transform degrades gracefully.
func decodeToSuggestions(text string, entities []pipelines.Entity, vocab VerbVocab) ([]correction.Suggestion, error) {
	type word struct {
		subwords  []string
		hadLeader bool
		tagEntity pipelines.Entity
		spanStart uint
		spanEnd   uint
	}
	var words []word
	var cur word
	for _, e := range entities {
		stripped, hadLeader := stripBoundary(e.Word)
		if hadLeader || len(cur.subwords) == 0 {
			if len(cur.subwords) > 0 {
				words = append(words, cur)
			}
			cur = word{tagEntity: e, hadLeader: hadLeader, spanStart: e.Start, spanEnd: e.End}
		} else {
			cur.spanEnd = e.End
		}
		cur.subwords = append(cur.subwords, stripped)
	}
	if len(cur.subwords) > 0 {
		words = append(words, cur)
	}

	var out []correction.Suggestion
	skippedTransforms := 0
	textLen := len(text)
	for _, w := range words {
		wordText := strings.Join(w.subwords, "")
		pieces, skipped := applyTag(wordText, w.tagEntity.Entity, vocab)
		skippedTransforms += skipped
		// KEEP / OOV / empty tag: no suggestion.
		if len(pieces) == 1 && pieces[0] == wordText {
			continue
		}
		// hugot's Rust tokenizers emit Start/End that INCLUDE the leading
		// whitespace of the subword (when hadLeader is true). To keep the
		// span == literal original bytes, prepend a space to the
		// replacement so applying [Start,End) yields the same surface form.
		if w.hadLeader && len(pieces) > 0 {
			pieces = append([]string{" "}, pieces...)
		}
		span := correction.Span{Start: int(w.spanStart), End: int(w.spanEnd)}
		if err := span.Validate(textLen); err != nil {
			continue
		}
		out = append(out, correction.Suggestion{
			Span:        span,
			Replacement: strings.Join(pieces, ""),
			Model:       correction.ModelGECToR,
			Confidence:  float64(w.tagEntity.Score),
		})
	}
	if skippedTransforms > 0 {
		slog.Default().Debug("gector: verb-form transforms skipped (unmapped)", "count", skippedTransforms)
	}
	return out, nil
}

// GECToR tag prefixes (per gotutiyan/gector-deberta-large-5k labels.json).
const (
	tagKeep    = "$KEEP"
	tagDelete  = "$DELETE"
	tagOOV     = "<OOV>"
	tagPrefixR = "$REPLACE_"
	tagPrefixA = "$APPEND_"
	tagPrefixT = "$TRANSFORM_"
	tagCaseCap = "$TRANSFORM_CASE_CAPITAL"
	tagCaseLow = "$TRANSFORM_CASE_LOWER"
)

// applyTag returns the word-pieces resulting from applying a single GECToR
// tag to a token, plus a count of tags the decoder chose to skip (verb-form
// transforms without a vocab lookup). For $TRANSFORM_VERB_<FROM>_<TO>, the
// (current token, FROM_TO) pair is looked up in vocab; a hit returns the
// target inflected form, a miss falls back to the original token.
func applyTag(token, tag string, vocab VerbVocab) ([]string, int) {
	switch {
	case tag == tagKeep || tag == tagOOV || tag == "":
		return []string{token}, 0
	case tag == tagDelete:
		return []string{}, 0
	case strings.HasPrefix(tag, tagPrefixR):
		return []string{strings.TrimPrefix(tag, tagPrefixR)}, 0
	case strings.HasPrefix(tag, tagPrefixA):
		return []string{token, strings.TrimPrefix(tag, tagPrefixA)}, 0
	case tag == tagCaseCap:
		return []string{strings.Title(strings.ToLower(token))}, 0 //nolint:staticcheck // GECToR-side normalisation
	case tag == tagCaseLow:
		return []string{strings.ToLower(token)}, 0
	case strings.HasPrefix(tag, tagPrefixT):
		fromTo := strings.TrimPrefix(tag, tagPrefixT) // e.g. "VERB_VB_VBZ"
		if vocab != nil {
			if forms, ok := vocab[token]; ok {
				if target, ok := forms[fromTo]; ok {
					return []string{target}, 0
				}
			}
		}
		// CASE / AGREEMENT transforms (non-verb) are unsupported in the
		// spike; emit the original token and count as skipped.
		return []string{token}, 1
	}
	return []string{token}, 1
}

// loadVerbVocab parses gector's verb-form-vocab.txt (one entry per line:
// "source_target:FROM_TO\n"). The resulting map supports
// applyTag's $TRANSFORM_VERB_<FROM>_<TO> lookups. A missing or unreadable
// file returns an empty vocab and a non-nil error; callers should treat the
// error as a soft warning (decoding degrades to "no verb transform").
func loadVerbVocab(path string) (VerbVocab, error) {
	v := VerbVocab{}
	if path == "" {
		return v, nil
	}
	f, err := os.Open(path) //nolint:gosec // path comes from controlled config
	if err != nil {
		return v, err
	}
	defer func() { _ = f.Close() }()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		// Format: "source_target:FROM_TO"  e.g. "go_goes:VB_VBZ"
		colon := strings.IndexByte(line, ':')
		underscore := strings.IndexByte(line, '_')
		if colon < 0 || underscore < 0 || underscore >= colon {
			continue
		}
		source := line[:underscore]
		target := line[underscore+1 : colon]
		fromTo := line[colon+1:]
		if source == "" || target == "" || fromTo == "" {
			continue
		}
		if v[source] == nil {
			v[source] = map[string]string{}
		}
		v[source][fromTo] = target
	}
	if err := scanner.Err(); err != nil {
		return v, err
	}
	return v, nil
}
