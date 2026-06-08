//go:build cgo

package harperffi

import (
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

// These tests exercise the pure loanword filter with synthetic suggestions
// mirroring real Harper lint output (captured via diagnostic). They make no C
// calls, so they are fast and deterministic.

const (
	msgTitleCase = "The canonical dictionary spelling is title case: `X`."
	msgSpelling  = "Did you mean to spell `X` this way?"
	msgPronounI  = "The first-person singular subject pronoun must be capitalized."
	msgSentCap   = "This sentence does not start with a capital letter"
	msgSVA       = "The form of the verb must agree in grammatical number with the pronoun."
)

func ids(sugs []correction.Suggestion) []string {
	out := make([]string, len(sugs))
	for i, s := range sugs {
		out[i] = s.Replacement
	}
	return out
}

// Bug #2: the clean loanphrase "café au lait" must survive untouched — both the
// title-case (au->Au) and spelling (au->a, lait->laid) false positives are
// dropped because the words chain off the accented "café".
func TestFilterDropsLoanwordChainFalsePositives(t *testing.T) {
	const text = "We paid 5 euros for the café au lait."
	// byte offsets (é is 2 bytes): café [24,29), au [30,32), lait [33,37)
	require.Equal(t, "café", text[24:29])
	require.Equal(t, "au", text[30:32])
	require.Equal(t, "lait", text[33:37])
	sugs := []correction.Suggestion{
		{Span: correction.Span{Start: 30, End: 32}, Replacement: "Au", Message: msgTitleCase, Model: correction.ModelHarper},
		{Span: correction.Span{Start: 30, End: 32}, Replacement: "a", Message: msgSpelling, Model: correction.ModelHarper},
		{Span: correction.Span{Start: 33, End: 37}, Replacement: "laid", Message: msgSpelling, Model: correction.ModelHarper},
	}
	got := filterLoanwordFalsePositives(text, sugs)
	require.Empty(t, got, "all loanword false positives must be dropped; got %v", ids(got))
}

// A genuine English misspelling with no accented neighbour is kept.
//
//nolint:misspell // "recieved" is an intentional misspelling under test
func TestFilterKeepsPlainSpelling(t *testing.T) {
	const text = "I recieved your letter."
	sugs := []correction.Suggestion{
		{Span: correction.Span{Start: 2, End: 10}, Replacement: "received", Message: msgSpelling, Model: correction.ModelHarper},
	}
	got := filterLoanwordFalsePositives(text, sugs)
	require.Len(t, got, 1)
	require.Equal(t, "received", got[0].Replacement)
}

// Proper-noun title-case (london->London) with no accent is kept.
func TestFilterKeepsProperNounTitleCase(t *testing.T) {
	const text = "i went to london last summer."
	sugs := []correction.Suggestion{
		{Span: correction.Span{Start: 0, End: 1}, Replacement: "I", Message: msgPronounI, Model: correction.ModelHarper},
		{Span: correction.Span{Start: 10, End: 16}, Replacement: "London", Message: msgTitleCase, Model: correction.ModelHarper},
	}
	got := filterLoanwordFalsePositives(text, sugs)
	require.Len(t, got, 2, "no accented word -> nothing dropped")
}

// id 60: a real misspelling ("dont") separated from the accented word ("naïve")
// by an unflagged word ("plan") must NOT be chained into the foreign zone.
func TestFilterKeepsSpellingSeparatedFromAccent(t *testing.T) {
	const text = "The naïve plan dont work."
	// naïve [4,10) (ï is 2 bytes), plan [11,15), dont [16,20)
	require.Equal(t, "naïve", text[4:10])
	require.Equal(t, "dont", text[16:20])
	sugs := []correction.Suggestion{
		{Span: correction.Span{Start: 16, End: 20}, Replacement: "don't", Message: msgSpelling, Model: correction.ModelHarper},
	}
	got := filterLoanwordFalsePositives(text, sugs)
	require.Len(t, got, 1, "dont is not adjacent to the accented word; keep the fix")
	require.Equal(t, "don't", got[0].Replacement)
}

// Non-dictionary lints (SVA, sentence-start caps) are never gated, even adjacent
// to an accent.
func TestFilterKeepsStructuralLintsNearAccent(t *testing.T) {
	const text = "I has a café near my house."
	// has [2,5) (SVA) — far from café [9,14); but assert SVA is never gateable.
	sugs := []correction.Suggestion{
		{Span: correction.Span{Start: 2, End: 5}, Replacement: "have", Message: msgSVA, Model: correction.ModelHarper},
	}
	got := filterLoanwordFalsePositives(text, sugs)
	require.Len(t, got, 1)
	require.Equal(t, "have", got[0].Replacement)
}

func TestIsLoanwordGateable(t *testing.T) {
	require.True(t, isLoanwordGateable(msgTitleCase))
	require.True(t, isLoanwordGateable(msgSpelling))
	require.False(t, isLoanwordGateable(msgPronounI))
	require.False(t, isLoanwordGateable(msgSentCap))
	require.False(t, isLoanwordGateable(msgSVA))
}

func TestTokenizeWordsMarksAccented(t *testing.T) {
	words := tokenizeWords("the café au lait")
	require.Len(t, words, 4)
	require.False(t, words[0].accented) // the
	require.True(t, words[1].accented)  // café
	require.False(t, words[2].accented) // au
	require.False(t, words[3].accented) // lait
}
