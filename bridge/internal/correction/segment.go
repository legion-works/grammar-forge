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
func SegmentSentences(text string) []SentenceSegment {
	if strings.TrimSpace(text) == "" {
		return nil
	}
	if looksLikeCode(text) {
		return []SentenceSegment{{Start: 0, End: len(text)}}
	}
	tok := getTokenizer()
	if tok == nil {
		return []SentenceSegment{{Start: 0, End: len(text)}}
	}
	sents := tok.Tokenize(text)
	if len(sents) == 0 {
		return []SentenceSegment{{Start: 0, End: len(text)}}
	}
	segs := make([]SentenceSegment, 0, len(sents))
	cursor := 0
	for _, s := range sents {
		t := strings.TrimSpace(s.Text)
		if t == "" {
			continue
		}
		idx := strings.Index(text[cursor:], t)
		if idx < 0 {
			// Tokenizer text does not align with the source (should not
			// happen — punkt preserves the input). Bail to whole-text rather
			// than emit wrong offsets.
			return []SentenceSegment{{Start: 0, End: len(text)}}
		}
		start := cursor + idx
		segs = append(segs, SentenceSegment{Start: start, End: start + len(t)})
		cursor = start + len(t)
	}
	if len(segs) == 0 {
		return []SentenceSegment{{Start: 0, End: len(text)}}
	}
	return segs
}
