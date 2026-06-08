//go:build cgo

package harperffi

import "github.com/grammarforge/bridge/internal/correction"

// lintKindToCategory maps harper-core 2.4.0 LintKind to_string_key() values to
// the bridge's /correct category. Keys are the authoritative, pinned set from
// harper-core-2.4.0 src/linting/lint_kind.rs (to_string_key). Grammar kinds map
// to correction.CategoryGrammar (""), which omits the JSON field (back-compat).
// Any kind NOT in this map falls through to "" (grammar) — never a wrong colour.
var lintKindToCategory = map[string]string{
	// spelling
	"Spelling": correction.CategorySpelling,
	"Typo":     correction.CategorySpelling,
	// punctuation
	"Punctuation": correction.CategoryPunctuation,
	// typography
	"Formatting": correction.CategoryTypography,
	// grammar ("") — listed explicitly for greppability
	"Agreement":      correction.CategoryGrammar,
	"BoundaryError":  correction.CategoryGrammar,
	"Capitalization": correction.CategoryGrammar,
	"Eggcorn":        correction.CategoryGrammar,
	"Grammar":        correction.CategoryGrammar,
	"Malapropism":    correction.CategoryGrammar,
	"Miscellaneous":  correction.CategoryGrammar,
	"Nonstandard":    correction.CategoryGrammar,
	// style
	"Enhancement": correction.CategoryStyle,
	"Readability": correction.CategoryStyle,
	"Redundancy":  correction.CategoryStyle,
	"Regionalism": correction.CategoryStyle,
	"Repetition":  correction.CategoryStyle,
	"Style":       correction.CategoryStyle,
	"Usage":       correction.CategoryStyle,
	"WordChoice":  correction.CategoryStyle,
}

// categoryForLintKind returns the /correct category for a Harper LintKind string
// key. Unmapped/empty kinds return CategoryGrammar ("") so an unexpected kind
// degrades to today's behaviour (grammar, no JSON field), never a wrong label.
func categoryForLintKind(kind string) string {
	if c, ok := lintKindToCategory[kind]; ok {
		return c
	}
	return correction.CategoryGrammar
}
