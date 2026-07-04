package correction

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// TestDialectRepairRevertsAmericanization is the canonical E2 case from the
// plan: the LLM Americanized "colour" back to "color" and the rule must
// revert it because the original carried the British spelling.
func TestDialectRepairRevertsAmericanization(t *testing.T) {
	rule := NewDialectSpellingRepair(map[string]string{"color": "colour", "organize": "organise"})
	got := rule("I like the colour scheme.", "I like the color scheme.")
	require.Equal(t, "I like the colour scheme.", got)
}

// TestDialectRepairPreservesCapital verifies sentence-initial cap
// preservation: when the user wrote "Colour" and the LLM produced "Color",
// the revert must restore "Colour", not "colour" — the user's leading
// capital is their own style, not the LLM's.
func TestDialectRepairPreservesCapital(t *testing.T) {
	rule := NewDialectSpellingRepair(map[string]string{"color": "colour"})
	got := rule("Colour is key.", "Color is key.")
	require.Equal(t, "Colour is key.", got)
}

// TestDialectRepairLeavesUserAmericanAlone guards the rule's primary
// invariant: when the user wrote American, there is no dialect form in
// the original, and the rule does nothing. We never silently rewrite the
// user's intent.
func TestDialectRepairLeavesUserAmericanAlone(t *testing.T) {
	rule := NewDialectSpellingRepair(map[string]string{"color": "colour"})
	got := rule("I like the color scheme.", "I like the color scheme.")
	require.Equal(t, "I like the color scheme.", got)
}

// TestDialectRepairWholeWordOnly pins the whole-word boundary: "laboratory"
// MUST NOT become "labouratory" even when "labor" → "labour" is in the
// lexicon. A failure here usually means the boundary regex is anchored
// by string-len + ascii byte checks instead of letter-class boundaries.
func TestDialectRepairWholeWordOnly(t *testing.T) {
	rule := NewDialectSpellingRepair(map[string]string{"labor": "labour"})
	got := rule("The labour laboratory.", "The labor laboratory.")
	require.Equal(t, "The labour laboratory.", got)
}

// TestDialectRepairMixedCaseMidSentence covers the case the dispatch prompt
// asks for beyond the plan's four: a non-sentence-initial capital must
// survive the revert. Original "The Colour scheme" / corrected "The Color
// scheme" → must restore "Colour" (cap preserved) without disturbing the
// surrounding lowercase words.
func TestDialectRepairMixedCaseMidSentence(t *testing.T) {
	rule := NewDialectSpellingRepair(map[string]string{"color": "colour"})
	got := rule("The Colour scheme feels off.", "The Color scheme feels off.")
	require.Equal(t, "The Colour scheme feels off.", got)
}

// TestDialectRepairSkipsWhenCorrectionAlreadyHasDialectal: if the LLM
// output already contains both forms (the user wrote British, the LLM
// preserved British), the rule is a no-op even though the American form
// also appears in the corrected text. Without this guard the rule would
// revert "color" → "colour" on the US-form piece of a sentence that also
// has the British form, producing a duplicate "colour".
func TestDialectRepairSkipsWhenCorrectionAlreadyHasDialectal(t *testing.T) {
	rule := NewDialectSpellingRepair(map[string]string{"color": "colour"})
	// LLM added "color picker" while preserving "colour scheme" — rule
	// must NOT flip the "color" inside "color picker".
	got := rule("The colour scheme.", "The colour scheme and color picker.")
	// "color picker" stays American (no dialect form in original at that
	// position) and "colour scheme" stays British (already dialect). No
	// change.
	require.Equal(t, "The colour scheme and color picker.", got)
}

// TestDialectRepairIgnoresEmptyOrDisabledLexicon: a constructor
// robustness check — empty map MUST no-op without indexing a nil map,
// and a constructor called with no lexicon at all is silently disabled
// rather than crashing.
func TestDialectRepairIgnoresEmptyOrDisabledLexicon(t *testing.T) {
	t.Run("empty lexicon is a no-op", func(t *testing.T) {
		rule := NewDialectSpellingRepair(map[string]string{})
		got := rule("I like the colour scheme.", "I like the color scheme.")
		require.Equal(t, "I like the color scheme.", got, "empty lexicon must never revert")
	})
	t.Run("missing pair is unchanged", func(t *testing.T) {
		rule := NewDialectSpellingRepair(map[string]string{"organize": "organise"})
		// color is not in the lexicon — must be left alone even when the
		// user wrote colour in the original.
		got := rule("I like the colour scheme.", "I like the color scheme.")
		require.Equal(t, "I like the color scheme.", got)
	})
}

// TestDialectRepairMultiplePairsInOneSentence is the regression anchor for
// the multi-pair splice-ordering bug found in cross-family review
// (quartet-e-rev finding #1). When 2+ distinct (american, dialect) pairs
// trigger in the same sentence, the rule must produce the SAME byte-for-byte
// revert on every run — independent of Go's randomised map-iteration order —
// and a clean (un-concatenated) full revert of every word. Run with -count=50
// to flush out map-iteration-order drift; without the splice-sort fix this
// reproducibly corrupts output ("myneighbourr'sfavouritee armour", etc.)
// roughly 11/12 of runs.
func TestDialectRepairMultiplePairsInOneSentence(t *testing.T) {
	rule := NewDialectSpellingRepair(map[string]string{
		"color":    "colour",
		"neighbor": "neighbour",
		"favorite": "favourite",
		"armor":    "armour",
	})
	got := rule(
		"I love the colour of my neighbour's favourite armour.",
		"I love the color of my neighbor's favorite armor.",
	)
	require.Equal(t,
		"I love the colour of my neighbour's favourite armour.",
		got,
		"multi-pair revert must restore every dialect word exactly, regardless of map-iteration order")
}

// TestDialectRepairAllCapsPreserved caps the case-preservation matrix at
// the ALL-CAPS end: when the matched whole word is entirely uppercase
// (length > 1), the replacement is rendered fully uppercase too. Reviewer
// finding #5 (quartet-e-rev): "I LOVE COLOUR" / "I LOVE COLOR" must yield
// "I LOVE COLOUR", not "Colour".
func TestDialectRepairAllCapsPreserved(t *testing.T) {
	rule := NewDialectSpellingRepair(map[string]string{"color": "colour"})
	got := rule("I LOVE COLOUR SO MUCH.", "I LOVE COLOR SO MUCH.")
	require.Equal(t, "I LOVE COLOUR SO MUCH.", got)
}
