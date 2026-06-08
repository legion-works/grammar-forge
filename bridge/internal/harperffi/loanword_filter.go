//go:build cgo

package harperffi

import (
	"strings"
	"unicode"

	"github.com/grammarforge/bridge/internal/correction"
)

// harperMsgTitleCase marks Harper's title-case dictionary-spelling lint
// ("The canonical dictionary spelling is title case: `Au`."). It is the ONE
// residual message check the bridge keeps: harper-core emits the same
// Capitalization LintKind for the title-case dictionary rule, the first-person
// "I" rule, AND sentence-initial capitalisation, and exposes no finer kind or
// per-lint rule key over the FFI. Only the title-case dictionary rule produces
// foreign-loanword false positives; the pronoun-"I" and sentence-start fixes
// are real and must survive even next to an accented word. So Capitalization is
// disambiguated on this marker; Spelling needs no such split.
const harperMsgTitleCase = "title case"

// isLoanwordGateable reports whether a lint (by its kind, with the message used
// only to disambiguate the overloaded Capitalization kind) is one of the
// dictionary-driven categories that can misfire on foreign loanwords:
//   - Spelling: always gateable ("Did you mean to spell ...").
//   - Capitalization: gateable ONLY for the title-case dictionary rule (see
//     harperMsgTitleCase); pronoun-"I" / sentence-start caps are never gated.
//
// Structural lints (Agreement, Repetition, Punctuation, ...) are correct on
// foreign words too and are never gated. Gateability is necessary but not
// sufficient: the accent-window heuristic in filterLoanwordFalsePositives still
// restricts actual dropping to a foreign-word context.
func isLoanwordGateable(kind, message string) bool {
	switch kind {
	case lintKindSpelling:
		return true
	case lintKindCapitalization:
		return strings.Contains(message, harperMsgTitleCase)
	default:
		return false
	}
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
// Known limitations (quantified by the Task 8 spike, 2026-06-08; deliberately
// NOT fixed — the filter is load-bearing for the clean eval and both candidate
// rewrites either regress it or are unverified):
//   - False negative: a genuine misspelling immediately next to an accented word
//     (a typo right after "café") is suppressed (foreignness chains through it).
//   - False positive: a clean accent-FREE loanphrase (e.g. "je ne sais quoi")
//     has no accented anchor and so leaks through and IS flagged. This class is
//     now addressable via the user dictionary (SPEC §6, GF_HARPER_USER_DICT) —
//     add the loan terms — rather than by complicating this heuristic.
//
// kinds is the Harper LintKind per suggestion, parallel to sugs; together with
// each suggestion's message it decides gateability via isLoanwordGateable,
// replacing the previous message-substring classification.
func filterLoanwordFalsePositives(text string, sugs []correction.Suggestion, kinds []string) []correction.Suggestion {
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
		if i >= len(kinds) || !isLoanwordGateable(kinds[i], s.Message) {
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
