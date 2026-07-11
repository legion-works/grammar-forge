package correction

import (
	"strings"
	"sync"

	"github.com/neurosnap/sentences"
	"github.com/neurosnap/sentences/english"
)

// SentenceSegment is a half-open BYTE range [Start, End) into the source text
// covering one sentence (per-sentence pipeline unit; spans produced inside a
// segment are sentence-relative and shifted by Start on reassembly).
type SentenceSegment struct {
	Start int
	End   int
}

// tokenizer is the process-wide punkt sentence tokenizer. Built once (the
// english data load is the expensive part); Tokenize is read-only after.
var (
	tokenizerOnce sync.Once
	tokenizer     *sentences.DefaultSentenceTokenizer
)

func getTokenizer() *sentences.DefaultSentenceTokenizer {
	tokenizerOnce.Do(func() {
		t, err := english.NewSentenceTokenizer(nil)
		if err != nil {
			// Leave tokenizer nil; SegmentSentences degrades to whole-text.
			return
		}
		tokenizer = t
	})
	return tokenizer
}

// codeIndicators are substrings that essentially never appear in English
// prose but are routine in code. Any hit (or 2+ semicolons, below) bypasses
// segmentation: punkt happily splits code at '?' / '.' ("arr.length"), and a
// code FRAGMENT sent to the LLM alone gets "corrected" differently than the
// whole line would (verified live: "arr[0] : null;" alone -> "arr[0]: null";
// the full line is left untouched). Whole-text = pre-pipeline behaviour.
var codeIndicators = []string{
	"();", "=>", "&&", "||", "++", "--", "==", "!=",
	"[]", "{}", "</", "/>", "::", "${", "$(",
}

// looksLikeCode reports whether text is plausibly source code rather than
// prose. Deliberately conservative: a false positive only means the text is
// checked whole (the legacy path), never a wrong correction.
func looksLikeCode(text string) bool {
	for _, ind := range codeIndicators {
		if strings.Contains(text, ind) {
			return true
		}
	}
	// One semicolon is prose ("I like tea; it calms me."); two or more in a
	// single check unit reads like statements.
	return strings.Count(text, ";") >= 2
}

// SegmentSentences splits text into sentence byte ranges using the punkt
// tokenizer (abbreviation-aware; "Dr." / "U.S." do not split). Offsets are
// recovered by locating each sentence in order — punkt sentences are
// contiguous substrings of the input. Degrades to a single whole-text
// segment when the input looks like code (see looksLikeCode), when the
// tokenizer is unavailable, or when a sentence cannot be relocated (never
// returns wrong offsets). Whitespace-only input -> empty.
//
// Newline behaviour: '\n' is a HARD sentence boundary. The text is
// pre-split on '\n' into line byte ranges; each non-empty line is fed to
// the punkt pipeline independently; recovered spans are shifted by the
// line's start offset and concatenated. The '\n' bytes stay uncovered
// (they sit BETWEEN line ranges, never inside a returned segment) so a
// fast path or the LLM can never emit an edit whose byte span contains
// or abuts a '\n'. Trailing '\r' on a line is stripped (CRLF = one
// boundary). Single-line input (no '\n') is byte-identical to the
// pre-change behaviour; the whole-line fallbacks (looksLikeCode,
// tokenizer unavailable, relocation failure) apply per line.
func SegmentSentences(text string) []SentenceSegment {
	if strings.TrimSpace(text) == "" {
		return nil
	}

	tok := getTokenizer()
	if tok == nil {
		// Tokenizer unavailable — fall back to whole-text, but the '\n'
		// boundary must still hold: split per line and yield one segment
		// per non-empty line. Same offset contract as the punkt path.
		return segmentLinesWithoutTokenizer(text)
	}

	var segs []SentenceSegment
	cursor := 0
	for cursor < len(text) {
		// Find the next '\n' from `cursor`; line = text[cursor:lineEnd] (may
		// be empty if the input starts with '\n' or has consecutive '\n's).
		lineEnd := strings.IndexByte(text[cursor:], '\n')
		var line string
		var lineNext int // index in `text` of the byte AFTER this line's '\n' (or len(text))
		if lineEnd < 0 {
			line = text[cursor:]
			lineNext = len(text)
		} else {
			line = text[cursor : cursor+lineEnd]
			lineNext = cursor + lineEnd + 1
		}
		// CRLF: strip a trailing '\r' so the line has no '\r' at its end.
		line = strings.TrimSuffix(line, "\r")
		if line != "" {
			segs = appendLineSegments(segs, line, cursor, tok)
		}
		cursor = lineNext
	}
	if len(segs) == 0 {
		// Every line was blank; treat as whitespace-only.
		return nil
	}
	return segs
}

// appendLineSegments runs the punkt pipeline on one line (which has had any
// trailing '\r' stripped), shifts each recovered span by lineStart, and
// appends to segs. Per-line fallbacks (looksLikeCode, relocation failure)
// apply here so a codey line bypasses punkt the same way the whole-text
// path does today. Returns the (possibly grown) segs slice.
func appendLineSegments(segs []SentenceSegment, line string, lineStart int, tok *sentences.DefaultSentenceTokenizer) []SentenceSegment {
	if looksLikeCode(line) {
		return append(segs, SentenceSegment{Start: lineStart, End: lineStart + len(line)})
	}
	sents := tok.Tokenize(line)
	if len(sents) == 0 {
		return append(segs, SentenceSegment{Start: lineStart, End: lineStart + len(line)})
	}
	cursor := 0
	for _, s := range sents {
		t := strings.TrimSpace(s.Text)
		if t == "" {
			continue
		}
		idx := strings.Index(line[cursor:], t)
		if idx < 0 {
			// Tokenizer output does not align with the source (should not
			// happen — punkt preserves the input). Bail to whole-line
			// rather than emit wrong offsets.
			return append(segs, SentenceSegment{Start: lineStart, End: lineStart + len(line)})
		}
		start := cursor + idx
		segs = append(segs, SentenceSegment{Start: lineStart + start, End: lineStart + start + len(t)})
		cursor = start + len(t)
	}
	return segs
}

// neighborContext returns the ±1 sentence context for the LLM (Task 6,
// GF_LLM_SENTENCE_CONTEXT): the text of the sentence segment immediately
// before segs[i] and the one immediately after, for use as reference-only
// context in the correction prompt. segs must be the SAME slice (and text
// the same source string) that produced index i — callers own that
// invariant; this function does no bounds validation beyond the neighbor
// existence checks below.
//
// Join semantics (deliberately NOT a bare strings.Join, which would leave a
// stray leading/trailing "\n" when only one neighbor exists):
//   - both prev and next exist -> prev + "\n" + next
//   - only prev exists         -> prev
//   - only next exists         -> next
//   - neither exists (segs has exactly one segment, i.e. i is both the
//     first and last index)    -> ""
//
// A real sentence segment (per SegmentSentences) is never empty, so "prev
// exists" and "prev != \"\"" are equivalent here — the switch below is safe
// to key off simple emptiness.
func neighborContext(text string, segs []SentenceSegment, i int) string {
	var prev, next string
	if i > 0 {
		p := segs[i-1]
		prev = text[p.Start:p.End]
	}
	if i < len(segs)-1 {
		n := segs[i+1]
		next = text[n.Start:n.End]
	}
	switch {
	case prev != "" && next != "":
		return prev + "\n" + next
	case prev != "":
		return prev
	case next != "":
		return next
	default:
		return ""
	}
}

// segmentLinesWithoutTokenizer is the no-punkt fallback: yield one segment
// per non-empty line (after stripping a trailing '\r' for CRLF). Preserves
// the '\n'-as-hard-boundary invariant and the half-open byte-range contract.
func segmentLinesWithoutTokenizer(text string) []SentenceSegment {
	var segs []SentenceSegment
	cursor := 0
	for cursor < len(text) {
		lineEnd := strings.IndexByte(text[cursor:], '\n')
		var line string
		var lineNext int
		if lineEnd < 0 {
			line = text[cursor:]
			lineNext = len(text)
		} else {
			line = text[cursor : cursor+lineEnd]
			lineNext = cursor + lineEnd + 1
		}
		line = strings.TrimSuffix(line, "\r")
		if line != "" {
			segs = append(segs, SentenceSegment{Start: cursor, End: cursor + len(line)})
		}
		cursor = lineNext
	}
	if len(segs) == 0 {
		return nil
	}
	return segs
}
