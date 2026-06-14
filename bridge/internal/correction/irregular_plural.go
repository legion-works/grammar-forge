package correction

import "strings"

// irregularPluralMap maps a known irregular or non-count noun base (lowercase)
// to its correct plural (or the base itself for non-count nouns where the
// trailing "s" is simply wrong). Used by repairIrregularPluralPossessive to
// replace Harper's confident-wrong possessive suggestion with the right form.
//
// Irregular plurals: the base is the singular; the value is the true plural.
// Non-count nouns: the base equals the value (drop the trailing "s").
//
// Extend only after a full cold golden eval confirms no clean-text FP.
var irregularPluralMap = map[string]string{
	// irregular plurals (singular → true plural)
	"tooth":  "teeth",
	"woman":  "women",
	"man":    "men",
	"child":  "children",
	"foot":   "feet",
	"goose":  "geese",
	"mouse":  "mice",
	"person": "people",
	"ox":     "oxen",
	// non-count nouns (base → base; trailing "s" is simply wrong)
	"luggage":     "luggage",
	"furniture":   "furniture",
	"information": "information",
	"equipment":   "equipment",
	"advice":      "advice",
}

// repairIrregularPluralPossessive filters Harper Spelling-category suggestions
// that replace a misspelled irregular/non-count plural (<base>s) with a
// possessive form (<base>'s). For each such suggestion whose base is in the
// curated irregularPluralMap, the replacement is rewritten to the correct
// plural so the fast-path first frame shows the right answer instead of an
// actively wrong possessive.
//
// Design rationale (probe 2026-06-14): Harper emits category="spelling" for
// these misfires (tooths→tooth's, womans→woman's, luggages→luggage's). Regular
// nouns (dogs, cats, students) are handled by GECToR, not Harper — Harper does
// NOT emit dogs→dog's at all. The category gate is therefore safe on its own,
// but the curated map is kept as belt-and-suspenders: only known-wrong bases
// are rewritten; unknown words are left untouched.
//
// Behaviour when enabled is false: returns suggs unchanged (no-op).
// Pure function; no I/O. CGo-free; safe to test with CGO_ENABLED=0.
func repairIrregularPluralPossessive(enabled bool, suggs []Suggestion) []Suggestion {
	if !enabled || len(suggs) == 0 {
		return suggs
	}
	out := suggs[:0:len(suggs)] // reuse backing array; avoids alloc when nothing changes
	changed := false
	for _, s := range suggs {
		if fixed, ok := fixIrregularPossessive(s); ok {
			out = append(out, fixed)
			changed = true
		} else {
			out = append(out, s)
		}
	}
	if !changed {
		return suggs // return original slice when nothing was rewritten
	}
	return out
}

// fixIrregularPossessive checks whether s is a Harper Spelling suggestion of
// the form <base>s → <base>'s where <base> is a known irregular/non-count
// noun. If so, it returns a copy of s with the replacement (and Replacements
// list) rewritten to the correct plural, and ok=true. Otherwise ok=false.
func fixIrregularPossessive(s Suggestion) (Suggestion, bool) {
	if s.Category != CategorySpelling {
		return s, false
	}
	// Replacement must end with "'s" (possessive form).
	if !strings.HasSuffix(s.Replacement, "'s") {
		return s, false
	}
	// Extract the base: replacement without the trailing "'s".
	base := strings.TrimSuffix(s.Replacement, "'s")
	if base == "" {
		return s, false
	}
	// Look up the base (case-insensitive) in the curated map.
	correctPlural, known := irregularPluralMap[strings.ToLower(base)]
	if !known {
		return s, false
	}
	// Preserve the original case of the base in the replacement.
	// If the base was title-cased (e.g. "Woman's" → base "Woman"), preserve it.
	corrected := matchCase(base, correctPlural)

	fixed := s
	fixed.Replacement = corrected
	// Rewrite the Replacements list: replace every entry that was the
	// possessive form with the correct plural; leave other alternatives
	// (e.g. "tooth" bare singular) intact.
	if len(s.Replacements) > 0 {
		newRepls := make([]string, len(s.Replacements))
		for i, r := range s.Replacements {
			if r == s.Replacement {
				newRepls[i] = corrected
			} else {
				newRepls[i] = r
			}
		}
		fixed.Replacements = newRepls
	}
	return fixed, true
}

// matchCase applies the case pattern of src to dst. If src is all-uppercase,
// dst is uppercased. If src is title-cased (first rune upper, rest lower),
// dst is title-cased. Otherwise dst is returned as-is (already lowercase from
// the map).
func matchCase(src, dst string) string {
	if dst == "" || src == "" {
		return dst
	}
	if src == strings.ToUpper(src) {
		return strings.ToUpper(dst)
	}
	// Title-case: first rune upper, rest lower.
	firstUpper := strings.ToUpper(string([]rune(src)[0]))
	restLower := strings.ToLower(string([]rune(src)[1:]))
	if firstUpper+restLower == src {
		return strings.ToUpper(string([]rune(dst)[0])) + string([]rune(dst)[1:])
	}
	return dst
}
