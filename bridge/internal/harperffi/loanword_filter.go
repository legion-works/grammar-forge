//go:build cgo

package harperffi

import (
	"strings"
	"unicode"

	"github.com/grammarforge/bridge/internal/correction"
)

// Harper lint message markers used to classify the two dictionary-driven lint
// categories that misfire on non-English loanwords. These are stable
// harper-core message strings (verified against the curated rule set); they are
// matched as substrings so minor wording changes upstream still classify.
const (
	harperMsgTitleCase = "title case"            // "...spelling is title case: `Au`."
	harperMsgSpelling  = "Did you mean to spell" // "Did you mean to spell `lait` this way?"
)

// isLoanwordGateable reports whether a Harper lint message is one of the
// dictionary-driven categories (title-case or spelling) that produce false
// positives on foreign loanwords. Structural lints (subject-verb agreement,
// sentence-start capitalisation, the first-person "I" rule, repeated words,
// indefinite article) are NOT gateable — they are correct on foreign words too.
func isLoanwordGateable(message string) bool {
	return strings.Contains(message, harperMsgTitleCase) ||
		strings.Contains(message, harperMsgSpelling)
}

// wordSpan is a byte range of a word token in the source text plus whether the
// word contains a non-ASCII letter (an accented loanword anchor, e.g. "café").
type wordSpan struct {
	start, end int
	accented   bool
}

// tokenizeWords splits text into word tokens (maximal runs of Unicode letters,
// so accented letters such as é/ï stay part of the word) with their byte ranges,
// flagging words that contain a non-ASCII letter.
func tokenizeWords(text string) []wordSpan {
	var words []wordSpan
	start := -1
	accented := false
	for i, r := range text {
		if unicode.IsLetter(r) {
			if start < 0 {
				start = i
				accented = false
			}
			if r > unicode.MaxASCII {
				accented = true
			}
			continue
		}
		if start >= 0 {
			words = append(words, wordSpan{start: start, end: i, accented: accented})
			start = -1
		}
	}
	if start >= 0 {
		words = append(words, wordSpan{start: start, end: len(text), accented: accented})
	}
	return words
}

// wordIndexFor returns the index of the word token containing span.Start, or -1
// if the span does not fall on a word (Harper spelling/title-case spans align to
// word boundaries).
func wordIndexFor(words []wordSpan, span correction.Span) int {
	for i, w := range words {
		if span.Start >= w.start && span.Start < w.end {
			return i
		}
	}
	return -1
}

// filterLoanwordFalsePositives drops Harper title-case and spelling suggestions
// that fall inside a foreign-loanword context, while keeping every other lint
// (and every spelling/title-case lint outside such a context).
//
// A foreign-loanword context is an accented word (e.g. "café") plus the chain of
// immediately-neighbouring word tokens that Harper itself flagged as spelling or
// title-case errors. This captures multi-word loanphrases like "café au lait"
// (where Harper wrongly proposes "au"->"Au"/"a" and "lait"->"laid") without
// touching genuine English misspellings, which carry no accented neighbour:
// e.g. an ordinary spelling fix and proper-noun capitalisation
// ("london"->"London") are unaffected.
//
// Known limitation: a genuine English misspelling written immediately next to
// an accented word (a typo right after "café") is also suppressed. This is a
// deliberate, rare trade-off — a future improvement is a real foreign-word
// dictionary or a user allowlist (SPEC §6 personal dictionary).
func filterLoanwordFalsePositives(text string, sugs []correction.Suggestion) []correction.Suggestion {
	if len(sugs) == 0 {
		return sugs
	}
	words := tokenizeWords(text)
	if len(words) == 0 {
		return sugs
	}

	// Map each gateable suggestion to its word index, and mark which words carry
	// a gateable lint (so foreignness can chain only through flagged words).
	gateableWord := make([]int, len(sugs)) // word index per sug, -1 if not gateable / no word
	flagged := make([]bool, len(words))
	for i, s := range sugs {
		gateableWord[i] = -1
		if !isLoanwordGateable(s.Message) {
			continue
		}
		wi := wordIndexFor(words, s.Span)
		if wi < 0 {
			continue
		}
		gateableWord[i] = wi
		flagged[wi] = true
	}

	// Seed foreignness from accented words, then propagate to fixpoint through
	// adjacent flagged words (left and right). A flagged word becomes foreign if
	// an immediate word-sequence neighbour is already foreign.
	foreign := make([]bool, len(words))
	for i := range words {
		foreign[i] = words[i].accented
	}
	for changed := true; changed; {
		changed = false
		for i := range words {
			if foreign[i] || !flagged[i] {
				continue
			}
			if (i > 0 && foreign[i-1]) || (i+1 < len(words) && foreign[i+1]) {
				foreign[i] = true
				changed = true
			}
		}
	}

	out := make([]correction.Suggestion, 0, len(sugs))
	for i, s := range sugs {
		if wi := gateableWord[i]; wi >= 0 && foreign[wi] {
			continue // drop loanword false positive
		}
		out = append(out, s)
	}
	return out
}
