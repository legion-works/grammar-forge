//go:build cgo && ORT

// Package gector runs the GECToR ONNX model in-process via hugot and implements
// correction.Corrector. One hugot Session is held for the process lifetime.
// Build with -tags ORT.
package gector

import (
	"context"
	"fmt"
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
	passes   int
}

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
	return &GECToR{session: sess, pipeline: pipe, passes: 3}, nil
}

// Close releases the ONNX session.
func (g *GECToR) Close() error { return g.session.Destroy() }

// Name reports the model tag.
func (g *GECToR) Name() correction.Model { return correction.ModelGECToR }

// Correct runs up to g.passes iterative GECToR passes. Between passes, the
// corrected text replaces the input; the loop ends early when a pass produces
// no edits. The final result is converted to byte-offset suggestions relative
// to the ORIGINAL text via diffToSuggestions.
func (g *GECToR) Correct(ctx context.Context, req correction.Request) ([]correction.Suggestion, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	current := req.Text
	for pass := 0; pass < g.passes; pass++ {
		out, err := g.pipeline.RunPipeline(ctx, []string{current})
		if err != nil {
			return nil, fmt.Errorf("gector inference: %w", err)
		}
		if len(out.Entities) == 0 {
			break
		}
		entities := out.Entities[0]
		next, _ := decodeEntities(entities)
		if next == current {
			break
		}
		current = next
	}
	if current == req.Text {
		return nil, nil
	}
	suggestions := correction.DiffToSuggestions(req.Text, current)
	for i := range suggestions {
		suggestions[i].Model = correction.ModelGECToR
		suggestions[i].Confidence = 0.9
	}
	return suggestions, nil
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

// decodeEntities groups the per-subword entities into words (using the Ġ/▁
// boundary marker on Entity.Word), applies the first subword's GECToR tag to
// each word, and returns the reconstructed text. The verb-form vocabulary is
// unused (the spike ran fine without it; we keep that behaviour for now).
func decodeEntities(entities []pipelines.Entity) (string, int) {
	type word struct {
		subwords  []string
		hadLeader bool
		tagEntity pipelines.Entity
	}
	var words []word
	var cur word
	for _, e := range entities {
		stripped, hadLeader := stripBoundary(e.Word)
		if hadLeader || len(cur.subwords) == 0 {
			if len(cur.subwords) > 0 {
				words = append(words, cur)
			}
			cur = word{tagEntity: e, hadLeader: hadLeader}
		}
		cur.subwords = append(cur.subwords, stripped)
	}
	if len(cur.subwords) > 0 {
		words = append(words, cur)
	}

	var out strings.Builder
	transformSkipped := 0
	for i, w := range words {
		wordText := strings.Join(w.subwords, "")
		pieces, skipped := applyTag(wordText, w.tagEntity.Entity)
		transformSkipped += skipped
		if i > 0 && w.hadLeader {
			out.WriteString(" ")
		}
		out.WriteString(strings.Join(pieces, ""))
	}
	return strings.TrimSpace(out.String()), transformSkipped
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
// transforms without vocabulary support). The spike ran fine at 5/8 tags
// without the verb vocab; we keep that graceful degradation.
func applyTag(token, tag string) ([]string, int) {
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
		// Verb-form / agreement transforms: keep the original token; the
		// resulting correction is degraded but the decoder does not crash.
		return []string{token}, 1
	}
	return []string{token}, 1
}
