//go:build cgo

package harperffi

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCategoryForLintKind(t *testing.T) {
	cases := map[string]string{
		"Spelling":           "spelling",
		"Typo":               "spelling",
		"Punctuation":        "punctuation",
		"Formatting":         "typography",
		"Agreement":          "",
		"BoundaryError":      "",
		"Capitalization":     "",
		"Eggcorn":            "",
		"Grammar":            "",
		"Malapropism":        "",
		"Enhancement":        "style",
		"Readability":        "style",
		"Redundancy":         "style",
		"Regionalism":        "style",
		"Repetition":         "style",
		"Style":              "style",
		"Usage":              "style",
		"WordChoice":         "style",
		"Miscellaneous":      "", // fallback → grammar
		"Nonstandard":        "", // fallback → grammar
		"TotallyUnknownKind": "", // unmapped → grammar fallback
		"":                   "", // empty → grammar
	}
	for kind, want := range cases {
		require.Equal(t, want, categoryForLintKind(kind), "kind %q", kind)
	}
}
