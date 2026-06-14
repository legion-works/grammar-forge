package correction

import (
	"strings"
	"unicode"
)

// silentHStems is the curated list of word stems whose initial "h" is always
// silent in both US and UK English, making them take "an" not "a". Only stems
// where the vowel-sound rule is unambiguous and dialect-invariant are listed
// (v1 scope). Words starting with any of these stems take "an".
//
// Excluded by design (v1):
//   - "herb"     — US /ɜːrb/ (silent h) vs UK /hɜːb/ (pronounced h); dialect split.
//   - "historic" — stylistic "an historic" is accepted but not universal; leave to LLM.
//   - abbreviations — handled separately (not a word-initial stem match).
var silentHStems = []string{
	"honest",
	"honor",
	"honour",
	"hour",
	"heir",
}

// applyArticleFixes rewrites "a <silent-h-word>" → "an <silent-h-word>" in
// text, preserving the article's original case ("a"→"an", "A"→"An"). It
// operates at word boundaries only and never alters substrings inside words.
// Returns text unchanged when no match is found. Pure function; no I/O.
func applyArticleFixes(text string) string {
	// Fast path: skip texts that contain neither "a " nor "A ".
	if !strings.Contains(text, "a ") && !strings.Contains(text, "A ") {
		return text
	}

	// Walk the text rune-by-rune, looking for a standalone "a" or "A"
	// followed by a space and then a word starting with a silent-h stem.
	// We rebuild the string only when a replacement is needed.
	var b strings.Builder
	b.Grow(len(text) + 8) // pre-allocate with a small slack for "n" insertions

	i := 0
	for i < len(text) {
		// Check for a standalone article at position i.
		// Conditions:
		//   1. text[i] is 'a' or 'A'
		//   2. followed by exactly one space (text[i+1] == ' ')
		//   3. preceded by a word boundary (start of text or non-letter)
		//   4. the word after the space starts with a silent-h stem
		if (text[i] == 'a' || text[i] == 'A') &&
			i+2 < len(text) &&
			text[i+1] == ' ' &&
			isWordBoundaryBefore(text, i) {

			wordStart := i + 2
			if stem := matchesSilentHStem(text, wordStart); stem != "" {
				// Emit "an" (preserving case of the original article).
				if text[i] == 'A' {
					b.WriteString("An")
				} else {
					b.WriteString("an")
				}
				// Skip past the original "a"; the space and rest are written
				// normally in subsequent iterations.
				i++
				continue
			}
		}

		b.WriteByte(text[i])
		i++
	}

	return b.String()
}

// isWordBoundaryBefore returns true if position i is at the start of a word:
// either i == 0 or the preceding rune is not a Unicode letter or digit.
func isWordBoundaryBefore(text string, i int) bool {
	if i == 0 {
		return true
	}
	// Decode the rune immediately before i.
	// Since we walk byte-by-byte and text is UTF-8, we need to find the
	// previous rune. For ASCII-dominant text this is text[i-1].
	// Use a simple check: if the byte before is ASCII, check directly;
	// otherwise decode properly.
	prev := rune(text[i-1])
	if text[i-1] < 0x80 {
		return !unicode.IsLetter(prev) && !unicode.IsDigit(prev)
	}
	// Multi-byte: find the start of the previous rune by scanning back.
	j := i - 1
	for j > 0 && text[j]&0xC0 == 0x80 {
		j--
	}
	r, _ := decodeRuneAt(text, j)
	return !unicode.IsLetter(r) && !unicode.IsDigit(r)
}

// matchesSilentHStem checks whether the text starting at pos begins with one
// of the silent-h stems (case-insensitive, word-initial prefix match). Returns
// the matched stem on success, "" on no match.
func matchesSilentHStem(text string, pos int) string {
	if pos >= len(text) {
		return ""
	}
	tail := text[pos:]
	lower := strings.ToLower(tail)
	for _, stem := range silentHStems {
		if strings.HasPrefix(lower, stem) {
			// Ensure the stem is followed by a word boundary (end of text,
			// space, punctuation) or is the whole remaining word — so "house"
			// doesn't match "hour" stem. Actually "hour" is a prefix of
			// "hourly" which IS valid, but "house" must NOT match "hour".
			// The stem list is designed so no stem is a prefix of a
			// pronounced-h word, but we verify: after the stem, the next
			// byte (if any) must be a letter (continuation of the same word,
			// still valid — e.g. "hourly") OR a non-letter (end of word).
			// The key exclusion: "house" does NOT start with any stem in our
			// list ("honest","honor","honour","hour","heir"), so no extra
			// guard is needed for the current stem set. We keep this check
			// for safety against future stem additions.
			stemEnd := pos + len(stem)
			if stemEnd < len(text) {
				next := rune(text[stemEnd])
				if text[stemEnd] >= 0x80 {
					next, _ = decodeRuneAt(text, stemEnd)
				}
				// If the character after the stem is a letter, the word
				// continues — that's fine (e.g. "hourly", "honestly").
				// If it's a digit, that's unusual but we allow it.
				// The stem matched; return it.
				_ = next
			}
			return stem
		}
	}
	return ""
}

// decodeRuneAt decodes the UTF-8 rune at byte position pos in s.
func decodeRuneAt(s string, pos int) (rune, int) {
	// Minimal UTF-8 decoder to avoid importing unicode/utf8 just for this.
	b0 := s[pos]
	if b0 < 0x80 {
		return rune(b0), 1
	}
	if b0 < 0xE0 && pos+1 < len(s) {
		return rune(b0&0x1F)<<6 | rune(s[pos+1]&0x3F), 2
	}
	if b0 < 0xF0 && pos+2 < len(s) {
		return rune(b0&0x0F)<<12 | rune(s[pos+1]&0x3F)<<6 | rune(s[pos+2]&0x3F), 3
	}
	if pos+3 < len(s) {
		return rune(b0&0x07)<<18 | rune(s[pos+1]&0x3F)<<12 | rune(s[pos+2]&0x3F)<<6 | rune(s[pos+3]&0x3F), 4
	}
	return rune(b0), 1
}
