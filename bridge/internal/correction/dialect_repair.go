package correction

import (
	"sort"
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

		// Sort splices ascending by start before the apply loop. The
		// splice list is built by ranging over `active` (which itself
		// is built from the `origWords` map), so without this sort the
		// list arrives in Go's randomised map-iteration order. Each
		// findWholeWordReplacements call returns splices for ONE
		// needle, already ascending — but concatenating the per-needle
		// batches in random order BREAKS the last-to-first apply
		// invariant: an earlier-by-byte splice sitting LATER in the
		// list would get applied first, slicing into byte offsets
		// that the earlier edit has already shifted, producing
		// non-deterministic text corruption ("myneighbourr'sfavouritee
		// armour"). The fix is structural, not on a per-needle basis —
		// even a fully sorted `active` list would still produce
		// interleaved splices when multiple needles match at non-aligned
		// offsets. Sorting here also makes the output deterministic
		// across runs. (quartet-e-rev finding #1, 2026-07-04.)
		sort.Slice(splices, func(i, j int) bool {
			if splices[i].start != splices[j].start {
				return splices[i].start < splices[j].start
			}
			// Tie-break on end (longer match first) so a fully-overlapping
			// pair of splices has stable drop precedence. Stable — no
			// production impact today (end always differs when start ties),
			// but keeps the sort a total order.
			return splices[i].end > splices[j].end
		})

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
// case-preserving repl. Case is preserved across the three-tier matrix
// (reviewer finding #5):
//
//   - matched span is entirely uppercase (len > 1, every byte A-Z):
//     emit the replacement fully uppercased ("COLOR" → "COLOUR");
//   - matched span starts with an uppercase letter but isn't all-upper:
//     title-case the replacement ("Color" → "Colour");
//   - matched span is all-lowercase: emit the replacement as-is
//     ("color" → "colour").
//
// Whole-word means the byte immediately before is not a letter and the
// byte immediately after is not a letter (or the string edge).
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
		splices = append(splices, dialectSplice{
			start: matchStart,
			end:   matchEnd,
			repl:  renderCasedReplacement(haystack[matchStart:matchEnd], repl),
		})
		i = matchEnd
	}
	return splices
}

// renderCasedReplacement inspects the case profile of the ASCII-matched
// span and emits the replacement in the matching case. The span is
// guaranteed single-byte ASCII by indexFoldASCII (a multi-byte rune >0x7F
// would never match our lowercase needle's bytes), so byte-by-byte
// inspection is sound and beats a UTF-8 decoder on the hot path.
func renderCasedReplacement(matched, repl string) string {
	allUpper := len(matched) > 1
	for k := 0; k < len(matched); k++ {
		b := matched[k]
		switch {
		case b >= 'a' && b <= 'z':
			allUpper = false
		case b >= 'A' && b <= 'Z':
			// still possibly all-upper
		default:
			// digits / punctuation disqualify allUpper but don't change
			// the title-case branch (which only checks the first byte).
			allUpper = false
		}
	}
	firstIsUpper := len(matched) > 0 && matched[0] >= 'A' && matched[0] <= 'Z'
	switch {
	case allUpper:
		return upperASCIIString(repl)
	case firstIsUpper:
		return upperFirstRune(repl)
	default:
		return repl
	}
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

// upperFirstRune returns s with its first byte upper-cased. ASCII-only —
// the lexicon is built from ASCII VarCon entries and dialect replacements
// (colour, theatre, …) are likewise ASCII.
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

// upperASCIIString returns s with every ASCII a-z byte mapped to A-Z.
// Non-letter bytes pass through unchanged; this matches the rule's
// scope (the embedded lexicon is ASCII).
func upperASCIIString(s string) string {
	hasLower := false
	for i := 0; i < len(s); i++ {
		if s[i] >= 'a' && s[i] <= 'z' {
			hasLower = true
			break
		}
	}
	if !hasLower {
		return s
	}
	b := []byte(s)
	for i := 0; i < len(b); i++ {
		if b[i] >= 'a' && b[i] <= 'z' {
			b[i] -= 'a' - 'A'
		}
	}
	return string(b)
}
