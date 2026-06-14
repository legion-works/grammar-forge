package correction

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// spellingPossessive builds a minimal Harper Spelling suggestion of the form
// <spanText> → <replacement> for use in tests. The span is a dummy [0, len).
func spellingPossessive(spanText, replacement string, alts ...string) Suggestion {
	repls := append([]string{replacement}, alts...)
	return Suggestion{
		Span:         Span{Start: 0, End: len(spanText)},
		Replacement:  replacement,
		Replacements: repls,
		Message:      "Did you mean to spell `" + spanText + "` this way?",
		Model:        ModelHarper,
		Confidence:   0.95,
		Category:     CategorySpelling,
	}
}

// grammarSuggestion builds a non-Spelling suggestion (e.g. GECToR grammar).
func grammarSuggestion(spanText, replacement string) Suggestion {
	return Suggestion{
		Span:        Span{Start: 0, End: len(spanText)},
		Replacement: replacement,
		Model:       ModelGECToR,
		Confidence:  0.87,
		Category:    CategoryGrammar,
	}
}

// ── Positive cases: irregular/non-count misfires must be repaired ────────────

func TestRepairIrregularPluralPossessive_ToothsToTeeth(t *testing.T) {
	in := spellingPossessive("tooths", "tooth's", "tooth", "toothy")
	out := repairIrregularPluralPossessive(true, []Suggestion{in})
	require.Len(t, out, 1)
	assert.Equal(t, "teeth", out[0].Replacement, "tooths→tooth's must become teeth")
	assert.Equal(t, "teeth", out[0].Replacements[0], "primary replacement in list must be teeth")
	// bare "tooth" alternative must be preserved unchanged
	assert.Equal(t, "tooth", out[0].Replacements[1])
}

func TestRepairIrregularPluralPossessive_WomansToWomen(t *testing.T) {
	in := spellingPossessive("womans", "woman's", "woman")
	out := repairIrregularPluralPossessive(true, []Suggestion{in})
	require.Len(t, out, 1)
	assert.Equal(t, "women", out[0].Replacement)
}

func TestRepairIrregularPluralPossessive_LuggagesToLuggage(t *testing.T) {
	in := spellingPossessive("luggages", "luggage's", "luggage")
	out := repairIrregularPluralPossessive(true, []Suggestion{in})
	require.Len(t, out, 1)
	assert.Equal(t, "luggage", out[0].Replacement, "non-count: luggages→luggage's must become luggage")
}

func TestRepairIrregularPluralPossessive_ManToMen(t *testing.T) {
	in := spellingPossessive("mans", "man's")
	out := repairIrregularPluralPossessive(true, []Suggestion{in})
	require.Len(t, out, 1)
	assert.Equal(t, "men", out[0].Replacement)
}

func TestRepairIrregularPluralPossessive_ChildToChildren(t *testing.T) {
	in := spellingPossessive("childs", "child's")
	out := repairIrregularPluralPossessive(true, []Suggestion{in})
	require.Len(t, out, 1)
	assert.Equal(t, "children", out[0].Replacement)
}

// ── Negative cases: must be left untouched ───────────────────────────────────

// KEY negative: dogs→dog's is a regular noun; Harper does NOT emit this
// (GECToR handles it), but if it ever did, the curated map must not touch it.
func TestRepairIrregularPluralPossessive_DogsPreserved(t *testing.T) {
	in := spellingPossessive("dogs", "dog's")
	out := repairIrregularPluralPossessive(true, []Suggestion{in})
	require.Len(t, out, 1)
	assert.Equal(t, "dog's", out[0].Replacement, "regular noun dogs→dog's must be untouched")
}

func TestRepairIrregularPluralPossessive_CatsPreserved(t *testing.T) {
	in := spellingPossessive("cats", "cat's")
	out := repairIrregularPluralPossessive(true, []Suggestion{in})
	require.Len(t, out, 1)
	assert.Equal(t, "cat's", out[0].Replacement, "regular noun cats→cat's must be untouched")
}

// Non-Spelling category suggestion must be left untouched even if it looks like
// a possessive (e.g. a GECToR grammar suggestion).
func TestRepairIrregularPluralPossessive_NonSpellingCategoryPreserved(t *testing.T) {
	in := grammarSuggestion("tooths", "tooth's")
	out := repairIrregularPluralPossessive(true, []Suggestion{in})
	require.Len(t, out, 1)
	assert.Equal(t, "tooth's", out[0].Replacement, "non-Spelling category must not be rewritten")
}

// A legit Spelling fix unrelated to possessives must be left untouched.
func TestRepairIrregularPluralPossessive_UnrelatedSpellingPreserved(t *testing.T) {
	in := spellingPossessive("recieve", "receive") //nolint:misspell // intentional misspelling as test input
	out := repairIrregularPluralPossessive(true, []Suggestion{in})
	require.Len(t, out, 1)
	assert.Equal(t, "receive", out[0].Replacement, "unrelated spelling fix must be untouched")
}

// A regular plural (books) with no possessive replacement must be untouched.
func TestRepairIrregularPluralPossessive_RegularPluralBooksPreserved(t *testing.T) {
	in := spellingPossessive("books", "book")
	out := repairIrregularPluralPossessive(true, []Suggestion{in})
	require.Len(t, out, 1)
	assert.Equal(t, "book", out[0].Replacement, "regular plural books must be untouched")
}

// ── Flag off: no-op ──────────────────────────────────────────────────────────

func TestRepairIrregularPluralPossessive_FlagOff_NoOp(t *testing.T) {
	in := spellingPossessive("tooths", "tooth's", "tooth")
	out := repairIrregularPluralPossessive(false, []Suggestion{in})
	require.Len(t, out, 1)
	assert.Equal(t, "tooth's", out[0].Replacement, "flag off: must be no-op")
}

// ── Idempotence ──────────────────────────────────────────────────────────────

func TestRepairIrregularPluralPossessive_Idempotent(t *testing.T) {
	in := spellingPossessive("tooths", "tooth's", "tooth")
	once := repairIrregularPluralPossessive(true, []Suggestion{in})
	twice := repairIrregularPluralPossessive(true, append([]Suggestion{}, once...))
	require.Len(t, twice, 1)
	assert.Equal(t, once[0].Replacement, twice[0].Replacement, "must be idempotent")
}

// ── Empty input ──────────────────────────────────────────────────────────────

func TestRepairIrregularPluralPossessive_EmptySlice(t *testing.T) {
	out := repairIrregularPluralPossessive(true, nil)
	assert.Nil(t, out)
	out2 := repairIrregularPluralPossessive(true, []Suggestion{})
	assert.Empty(t, out2)
}

// ── matchCase helper ─────────────────────────────────────────────────────────

func TestMatchCase_Lowercase(t *testing.T) {
	assert.Equal(t, "teeth", matchCase("tooth", "teeth"))
}

func TestMatchCase_TitleCase(t *testing.T) {
	assert.Equal(t, "Teeth", matchCase("Tooth", "teeth"))
}

func TestMatchCase_AllUpper(t *testing.T) {
	assert.Equal(t, "TEETH", matchCase("TOOTH", "teeth"))
}

func TestMatchCase_EmptySrc(t *testing.T) {
	assert.Equal(t, "teeth", matchCase("", "teeth"))
}
