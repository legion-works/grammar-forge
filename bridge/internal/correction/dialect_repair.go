package correction

import (
	"strings"
	"unicode"
)

// NewDialectSpellingRepair builds an OverEditRule that reverts an LLM
// dialect flip — when the user's input is British and the LLM output
// Americanized a word, restore the user's spelling BEFORE the diff is
// computed.
//
// Direction (only US→GB reverts are guarded; the GB→US direction is the
// LLM doing its job when the user wrote American):
//
//	corrected contains `american` as a whole word (case-insensitive),
//	AND original contains `dialect` (= the British form) as a whole word,
//	AND corrected does NOT already contain `dialect`,
//
// → splice `american` → `dialect` in corrected, preserving the original's
//
//	leading capital ("Color" → "Colour", not "colour").
//
// Performance. The hot path is the per-request `repairOverEdits` chain.
// Iterating all ~13k lexicon entries per call with per-pair regex
// compilation is the obvious O(N·M) trap. Instead, the constructor
// builds a small REVERSE map (dialect → american) ONCE, and the rule
// only inspects (american, dialect) pairs whose `dialect` form appears
// in the ORIGINAL — typically 0-2 per sentence. No per-call regex
// compilation, no per-call map allocation, no copy-of-corrected unless a
// revert is needed.
func NewDialectSpellingRepair(lexicon map[string]string) OverEditRule {
	if len(lexicon) == 0 {
		// Empty lexicon is the disabled/identity rule. Returning a
		// dedicated no-op closure (instead of a nil function value)
		// keeps the caller's `for _, rule := range rules` chain safe
		// under `len(rules) > 0` checks.
		return func(_, corrected string) string { return corrected }
	}

	// Reverse map: dialect (British) → american. We scan the ORIGINAL
	// for dialect words, so the reverse map's keys are the words we
	// actually look up at call time. The active-pair step walks the
	// ORIGINAL's unique whole-words (typically ~10–20 per sentence) and
	// looks each one up in this map — O(W) per call instead of O(N) over
	// the whole ~13k-pair lexicon.
	dialectToAmerican := make(map[string]string, len(lexicon))
	for us, gb := range lexicon {
		us = strings.ToLower(us)
		gb = strings.ToLower(gb)
		if us == "" || gb == "" || us == gb {
			continue
		}
		// Last-wins on duplicate British forms; keeps the map
		// deterministic under hand-edits upstream. The matching
		// (american, dialect) pair is recoverable from this map alone.
		dialectToAmerican[gb] = us
	}

	return func(original, corrected string) string {
		if original == corrected {
			return corrected
		}

		// Original-words-by-whole-word: collect lowercase tokens so we
		// can check dialect-presence with a map lookup. Tokens are
		// contiguous runs of letters; punctuation breaks the word.
		// "The Colour-scheme." produces {"the", "colour", "scheme"} —
		// the hyphen splits "Colour-scheme" into two tokens, which is
		// the right whole-word model for matching British spellings
		// ("colour" is its own word; "scheme" never collides with an
		// American→British pair in this corpus).
		origWords := scanLowercaseWords(original)

		// Build the active set in O(W) instead of O(N): for every word
		// the original actually contains, look it up in the reverse
		// map. Words not in the map are skipped wholesale, so the
		// 12,888-pair lexicon is touched once per original-word — at
		// most ~20 lookups per sentence.
		active := make([]dialectPair, 0, len(origWords))
		for gb := range origWords {
			if us, ok := dialectToAmerican[gb]; ok {
				active = append(active, dialectPair{american: us, dialect: gb})
			}
		}
		if len(active) == 0 {
			return corrected
		}

		// Collect which (american, dialect) pairs we should revert in
		// the corrected text. A pair is reverted only when the
		// corrected text contains the AMERICAN form as a whole word
		// AND does NOT already contain the DIALECT form. The second
		// guard prevents the rule from inserting a redundant dialect
		// form next to an LLM-preserved one ("colour scheme and color
		// picker" must not see "color picker" → "colour picker").
		var splices []dialectSplice
		corrWords := scanLowercaseWords(corrected)

		for _, p := range active {
			// Don't revert when the corrected text already carries the
			// dialect spelling on its own — flipping American would
			// only duplicate it.
			if corrWords[p.dialect] {
				continue
			}
			// Must contain the AMERICAN form as a whole word.
			if !corrWords[p.american] {
				continue
			}
			// Replace each whole-word occurrence of `american` in
			// corrected, case-preserving ("Color" → "Colour",
			// "color" → "colour", "COLOR" → "COLOUR"). We reuse a
			// raw-byte scan over the corrected string; the cap is
			// taken from the matched token's first rune.
			splices = append(splices, findWholeWordReplacements(corrected, p.american, p.dialect)...)
		}
		if len(splices) == 0 {
			return corrected
		}

		// Apply last-to-first so earlier byte offsets stay valid
		// (same house pattern as the other OverEditRule implementations
		// in overedit.go).
		out := corrected
		for i := len(splices) - 1; i >= 0; i-- {
			sp := splices[i]
			out = out[:sp.start] + sp.repl + out[sp.end:]
		}
		return out
	}
}

// dialectPair captures one (american, dialect) entry — both
// pre-normalised to lowercase at construction time.
type dialectPair struct {
	american string
	dialect  string
}

// dialectSplice is one byte-range replacement in the corrected text.
// Apply last-to-first so earlier byte offsets stay valid (same pattern
// as the rest of the OverEditRule families in overedit.go).
type dialectSplice struct {
	start, end int
	repl       string
}

// scanLowercaseWords returns the set of lowercase whole words found in
// s. A word is a maximal contiguous run of letters (Unicode letter class
// — non-letter runes, including ASCII punctuation, are word separators).
// The map keys are lowercase so callers can compare against the same
// normalization used by the lexicon builder.
func scanLowercaseWords(s string) map[string]bool {
	out := make(map[string]bool)
	for _, tok := range splitWords(s) {
		if tok == "" {
			continue
		}
		out[strings.ToLower(tok)] = true
	}
	return out
}

// splitWords returns each maximal letter-run in s as its own word.
// Non-letters break the run. Implemented directly (not via
// strings.Fields/FieldsFunc) so the boundary semantics stay in one place
// and the call graph stays inside this file — adding a Unicode-script
// exemption here would change neither the rule nor the test surface in
// surprising ways.
func splitWords(s string) []string {
	var words []string
	wordStart := -1
	for i, r := range s {
		isLetter := unicode.IsLetter(r)
		if isLetter {
			if wordStart < 0 {
				wordStart = i
			}
			continue
		}
		if wordStart >= 0 {
			words = append(words, s[wordStart:i])
			wordStart = -1
		}
	}
	if wordStart >= 0 {
		words = append(words, s[wordStart:])
	}
	return words
}

// findWholeWordReplacements locates every whole-word occurrence of
// needle in haystack and returns splices that replace it with
// case-preserving repl (lower, but with the FIRST rune's case copied
// from the matched token's first rune). Whole-word means the byte
// immediately before is not a letter and the byte immediately after is
// not a letter (or the string edge).
func findWholeWordReplacements(haystack, needle, repl string) []dialectSplice {
	if needle == "" {
		return nil
	}
	var splices []dialectSplice
	nlen := len(needle)
	i := 0
	for i < len(haystack) {
		// Find the next case-insensitive match for needle in haystack.
		j := indexFoldASCII(haystack[i:], needle)
		if j < 0 {
			break
		}
		matchStart := i + j
		matchEnd := matchStart + nlen
		// Whole-word guard: letter on either side disqualifies the
		// match (we must not flip "labor" inside "laboratory").
		if !isLeftBoundary(haystack, matchStart) || !isRightBoundary(haystack, matchEnd) {
			i = matchStart + 1
			continue
		}
		// Preserve the case of the first rune of the matched span.
		firstRune, _ := decodeFirstRune(haystack[matchStart:matchEnd])
		var casedRepl string
		if firstRune >= 'A' && firstRune <= 'Z' {
			casedRepl = upperFirstRune(repl)
		} else {
			casedRepl = repl
		}
		splices = append(splices, dialectSplice{
			start: matchStart,
			end:   matchEnd,
			repl:  casedRepl,
		})
		i = matchEnd
	}
	return splices
}

// isLeftBoundary reports whether position p in s is at the start of a
// word — p == 0 or the byte at p-1 is not an ASCII letter. ASCII-only
// because VarCon's vocabulary is ASCII; this keeps the check branch-free.
func isLeftBoundary(s string, p int) bool {
	if p == 0 {
		return true
	}
	return !isASCIILetter(s[p-1])
}

// isRightBoundary reports whether position p in s is at the end of a
// word — p == len(s) or the byte at p is not an ASCII letter.
func isRightBoundary(s string, p int) bool {
	if p >= len(s) {
		return true
	}
	return !isASCIILetter(s[p])
}

// isASCIILetter reports whether b is an ASCII a-z or A-Z letter. The
// lexicon is built from ASCII VarCon entries; non-ASCII bytes are
// always treated as word boundaries.
func isASCIILetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// indexFoldASCII returns the byte index of the first case-insensitive
// match of needle in s, or -1 when not found. ASCII-only — the lexicon
// is built from ASCII VarCon entries, so a Unicode-aware search would
// add cost without coverage.
func indexFoldASCII(s, needle string) int {
	nlen := len(needle)
	if nlen == 0 {
		return 0
	}
	if nlen > len(s) {
		return -1
	}
	firstLower := lowerASCII(needle[0])
	slen := len(s)
	for i := 0; i+nlen <= slen; i++ {
		if lowerASCII(s[i]) != firstLower {
			continue
		}
		// Match the rest of needle against s[i+1:i+nlen]
		// case-insensitively. ASCII-only.
		match := true
		for k := 1; k < nlen; k++ {
			if lowerASCII(s[i+k]) != lowerASCII(needle[k]) {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

// lowerASCII lowers a single ASCII letter; non-letters return unchanged.
// Used inline by the hot-path scanner — kept branch-free for the common
// letter case.
func lowerASCII(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + ('a' - 'A')
	}
	return c
}

// upperFirstRune returns s with its first rune upper-cased (ASCII-only).
// Dialect replacements are ASCII so we don't need full Unicode handling.
func upperFirstRune(s string) string {
	if s == "" {
		return s
	}
	c := s[0]
	if c >= 'a' && c <= 'z' {
		return string(c-('a'-'A')) + s[1:]
	}
	return s
}

// decodeFirstRune returns the first rune of s plus its byte width.
// Only ASCII is expected, but the helper is implemented in
// general form so it cannot fail on a non-ASCII diacritic slipped in
// from the corrected text (the caller uses the rune purely for casing).
func decodeFirstRune(s string) (rune, int) {
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c < 0x80:
			return rune(c), 1
		case c < 0xC0:
			// stray continuation byte — skip and keep scanning
		case c < 0xE0:
			if i+1 < len(s) {
				return rune(c&0x1F)<<6 | rune(s[i+1]&0x3F), 2
			}
			return rune(c), 1
		case c < 0xF0:
			if i+2 < len(s) {
				return rune(c&0x0F)<<12 | rune(s[i+1]&0x3F)<<6 | rune(s[i+2]&0x3F), 3
			}
			return rune(c), 1
		default:
			if i+3 < len(s) {
				return rune(c&0x07)<<18 | rune(s[i+1]&0x3F)<<12 | rune(s[i+2]&0x3F)<<6 | rune(s[i+3]&0x3F), 4
			}
			return rune(c), 1
		}
	}
	return 0, 0
}
