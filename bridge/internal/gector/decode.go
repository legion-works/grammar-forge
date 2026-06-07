//go:build cgo && ORT

package gector

import (
	"bufio"
	"log/slog"
	"os"
	"strings"
	"unicode"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/knights-analytics/hugot/pipelines"
)

// VerbVocab maps (currentToken, fromToTag) -> targetToken. It is loaded from
// the optional `<modelDir>/verb-form-vocab.txt` (gector's standard
// verb-form vocabulary). When absent or empty, $TRANSFORM_VERB_* tags
// gracefully degrade to "no change" (counted in decodeToSuggestions's skip
// return so callers can log it).
type VerbVocab map[string]map[string]string

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

// isWordContinuation reports whether a non-leadered subword is a genuine BPE
// continuation of the current word (it contains a letter or digit) rather than a
// standalone punctuation token. The GECToR tokenizer marks new words with a Ġ
// leader, but attaches trailing punctuation (".", ",", "?") to the stream
// WITHOUT a leader even though each punctuation mark is a SEPARATE token with its
// own tag. Merging such punctuation into the preceding word would let that word's
// $REPLACE/$TRANSFORM tag swallow the punctuation (e.g. "he." -> "him" dropping
// the "."). So only alphanumeric continuations are merged; punctuation starts a
// new (single-token) word and keeps its own tag.
func isWordContinuation(sub string) bool {
	for _, r := range sub {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			return true
		}
	}
	return false
}

// decodeToSuggestions groups the per-subword entities into words (using the
// Ġ/▁ boundary marker, and splitting standalone punctuation into its own word),
// applies the first subword's GECToR tag to each word, and emits a Suggestion
// per non-KEEP word.
//
// Span handling: the hugot tokenizer includes the leading space of a leadered,
// non-sentence-initial token in its span (e.g. " seen" -> [1,6)) but NOT for the
// sentence-initial token (e.g. "Me" -> [0,2), no preceding space). For a
// replacing edit the span is normalised to cover exactly the word bytes (any
// leading-space byte is dropped) and the replacement carries no leading space;
// for a deletion the leading space is kept inside the span so removing the word
// does not leave a double space.
//
// Each suggestion's confidence is the first subword's softmax Score (the
// per-token tag probability from the model). Verb-form transforms are looked up
// in vocab; misses are skipped (counted and logged) so a missing/unmapped
// transform degrades gracefully.
func decodeToSuggestions(text string, entities []pipelines.Entity, vocab VerbVocab) ([]correction.Suggestion, error) {
	type word struct {
		subwords  []string
		tagEntity pipelines.Entity
		spanStart uint
		spanEnd   uint
	}
	var words []word
	var cur word
	for _, e := range entities {
		stripped, hadLeader := stripBoundary(e.Word)
		startsNewWord := hadLeader || len(cur.subwords) == 0 || !isWordContinuation(stripped)
		if startsNewWord {
			if len(cur.subwords) > 0 {
				words = append(words, cur)
			}
			cur = word{tagEntity: e, spanStart: e.Start, spanEnd: e.End}
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
		repl := strings.Join(pieces, "")
		start := int(w.spanStart)
		end := int(w.spanEnd)
		// Normalise a leading-space byte out of the span for replacing edits so
		// span == the literal word bytes and the replacement carries no leading
		// space. Deletions (empty replacement) keep the space inside the span so
		// the surrounding text does not end up with a double space.
		if repl != "" && start < end && start < textLen && text[start] == ' ' {
			start++
		}
		span := correction.Span{Start: start, End: end}
		if err := span.Validate(textLen); err != nil {
			continue
		}
		out = append(out, correction.Suggestion{
			Span:        span,
			Replacement: repl,
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
//
// $APPEND_x inserts x AFTER the token WITH a separating space (the appended word
// is a new word, e.g. "listen" + $APPEND_to -> "listen to", not "listento").
func applyTag(token, tag string, vocab VerbVocab) ([]string, int) {
	switch {
	case tag == tagKeep || tag == tagOOV || tag == "":
		return []string{token}, 0
	case tag == tagDelete:
		return []string{}, 0
	case strings.HasPrefix(tag, tagPrefixR):
		return []string{strings.TrimPrefix(tag, tagPrefixR)}, 0
	case strings.HasPrefix(tag, tagPrefixA):
		return []string{token, " " + strings.TrimPrefix(tag, tagPrefixA)}, 0
	case tag == tagCaseCap:
		return []string{strings.Title(strings.ToLower(token))}, 0 //nolint:staticcheck // GECToR-side normalisation
	case tag == tagCaseLow:
		return []string{strings.ToLower(token)}, 0
	case strings.HasPrefix(tag, tagPrefixT):
		// $TRANSFORM_VERB_<FROM>_<TO> -> look up in the verb-form vocab.
		// The vocab's suffix key is just "FROM_TO" (e.g. "VBN_VBD"), not
		// the full "VERB_FROM_TO" — strip the "VERB_" prefix to get the
		// lookup key. Non-verb transforms (CASE, AGREEMENT) fall through
		// to the "no change" branch below.
		fromTo := strings.TrimPrefix(tag, tagPrefixT) // "VERB_VB_VBZ"
		fromTo = strings.TrimPrefix(fromTo, "VERB_")  // "VB_VBZ"
		if vocab != nil && fromTo != tagPrefixT {
			if forms, ok := vocab[token]; ok {
				if target, ok := forms[fromTo]; ok {
					return []string{target}, 0
				}
			}
		}
		// CASE / AGREEMENT / unmapped verb transforms: emit the original
		// token and count as skipped.
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
