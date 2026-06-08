//go:build cgo

package harperffi

import (
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

// These tests exercise the pure loanword filter with synthetic suggestions plus
// their Harper LintKind (parallel to the suggestion slice, as harper.go builds
// it). They make no C calls, so they are fast and deterministic.

// Harper LintKind values these tests use, mirroring real harper_get_lint_kind
// output (validated against real Harper). Spelling is always loanword-gateable;
// Capitalization is gateable only for the title-case dictionary rule; Agreement
// is never gateable.
const (
	kindSpelling       = lintKindSpelling
	kindCapitalization = lintKindCapitalization
	kindAgreement      = "Agreement"
)

// Real Harper messages, used only to disambiguate the overloaded Capitalization
// kind (title-case dictionary vs pronoun-I vs sentence-start).
const (
	msgTitleCase = "The canonical dictionary spelling is title case: `X`."
	msgPronounI  = "The first-person singular subject pronoun must be capitalized."
	msgSentStart = "This sentence does not start with a capital letter"
)

func ids(sugs []correction.Suggestion) []string {
	out := make([]string, len(sugs))
	for i, s := range sugs {
		out[i] = s.Replacement
	}
	return out
}

// Bug #2: the clean loanphrase "café au lait" must survive untouched — both the
// title-case (au->Au, Capitalization+title-case) and spelling (au->a, lait->laid,
// Spelling) false positives are dropped because the words chain off the accented
// "café".
func TestFilterDropsLoanwordChainFalsePositives(t *testing.T) {
	const text = "We paid 5 euros for the café au lait."
	// byte offsets (é is 2 bytes): café [24,29), au [30,32), lait [33,37)
	require.Equal(t, "café", text[24:29])
	require.Equal(t, "au", text[30:32])
	require.Equal(t, "lait", text[33:37])
	sugs := []correction.Suggestion{
		{Span: correction.Span{Start: 30, End: 32}, Replacement: "Au", Message: msgTitleCase, Model: correction.ModelHarper},
		{Span: correction.Span{Start: 30, End: 32}, Replacement: "a", Model: correction.ModelHarper},
		{Span: correction.Span{Start: 33, End: 37}, Replacement: "laid", Model: correction.ModelHarper},
	}
	kinds := []string{kindCapitalization, kindSpelling, kindSpelling}
	got := filterLoanwordFalsePositives(text, sugs, kinds)
	require.Empty(t, got, "all loanword false positives must be dropped; got %v", ids(got))
}

// A genuine English misspelling with no accented neighbour is kept.
//
//nolint:misspell // "recieved" is an intentional misspelling under test
func TestFilterKeepsPlainSpelling(t *testing.T) {
	const text = "I recieved your letter."
	sugs := []correction.Suggestion{
		{Span: correction.Span{Start: 2, End: 10}, Replacement: "received", Model: correction.ModelHarper},
	}
	got := filterLoanwordFalsePositives(text, sugs, []string{kindSpelling})
	require.Len(t, got, 1)
	require.Equal(t, "received", got[0].Replacement)
}

// Proper-noun title-case (london->London) and the pronoun-I capitalisation
// (i->I) with no accent are both kept. London is title-case-gateable but has no
// foreign context; pronoun-I is never gateable.
func TestFilterKeepsProperNounTitleCase(t *testing.T) {
	const text = "i went to london last summer."
	sugs := []correction.Suggestion{
		{Span: correction.Span{Start: 0, End: 1}, Replacement: "I", Message: msgPronounI, Model: correction.ModelHarper},
		{Span: correction.Span{Start: 10, End: 16}, Replacement: "London", Message: msgTitleCase, Model: correction.ModelHarper},
	}
	kinds := []string{kindCapitalization, kindCapitalization}
	got := filterLoanwordFalsePositives(text, sugs, kinds)
	require.Len(t, got, 2, "no accented word -> nothing dropped")
}

// Regression guard (reviewer): a real first-person "I" capitalisation fix
// immediately adjacent to an accented loanword must NOT be dropped. The pronoun-I
// rule shares the Capitalization kind with the title-case dictionary rule, so a
// naive kind-only gate would wrongly suppress this true positive.
func TestFilterKeepsPronounINextToAccent(t *testing.T) {
	const text = "At the café i sat."
	// café [7,12) (é is 2 bytes), i [13,14)
	require.Equal(t, "café", text[7:12])
	require.Equal(t, "i", text[13:14])
	sugs := []correction.Suggestion{
		{Span: correction.Span{Start: 13, End: 14}, Replacement: "I", Message: msgPronounI, Model: correction.ModelHarper},
	}
	got := filterLoanwordFalsePositives(text, sugs, []string{kindCapitalization})
	require.Len(t, got, 1, "pronoun-I cap is a real fix; never gated even next to an accent")
	require.Equal(t, "I", got[0].Replacement)
}

// Regression guard (reviewer): a sentence-start capitalisation fix adjacent to an
// accented loanword must NOT be dropped either (also a non-title-case
// Capitalization lint).
func TestFilterKeepsSentenceStartCapNextToAccent(t *testing.T) {
	const text = "café it was good."
	// café [0,5) (é is 2 bytes) is the first word; "it" [6,8) follows.
	require.Equal(t, "café", text[0:5])
	require.Equal(t, "it", text[6:8])
	sugs := []correction.Suggestion{
		{Span: correction.Span{Start: 6, End: 8}, Replacement: "It", Message: msgSentStart, Model: correction.ModelHarper},
	}
	got := filterLoanwordFalsePositives(text, sugs, []string{kindCapitalization})
	require.Len(t, got, 1, "sentence-start cap is a real fix; never gated even next to an accent")
	require.Equal(t, "It", got[0].Replacement)
}

// id 60: a real misspelling ("dont", Spelling) separated from the accented word
// ("naïve") by an unflagged word ("plan") must NOT be chained into the foreign
// zone.
func TestFilterKeepsSpellingSeparatedFromAccent(t *testing.T) {
	const text = "The naïve plan dont work."
	// naïve [4,10) (ï is 2 bytes), plan [11,15), dont [16,20)
	require.Equal(t, "naïve", text[4:10])
	require.Equal(t, "dont", text[16:20])
	sugs := []correction.Suggestion{
		{Span: correction.Span{Start: 16, End: 20}, Replacement: "don't", Model: correction.ModelHarper},
	}
	got := filterLoanwordFalsePositives(text, sugs, []string{kindSpelling})
	require.Len(t, got, 1, "dont is not adjacent to the accented word; keep the fix")
	require.Equal(t, "don't", got[0].Replacement)
}

// Non-dictionary lints (subject-verb agreement) are never gated, even adjacent
// to an accent.
func TestFilterKeepsStructuralLintsNearAccent(t *testing.T) {
	const text = "I has a café near my house."
	// has [2,5) (Agreement) — assert it is never gateable regardless of position.
	sugs := []correction.Suggestion{
		{Span: correction.Span{Start: 2, End: 5}, Replacement: "have", Model: correction.ModelHarper},
	}
	got := filterLoanwordFalsePositives(text, sugs, []string{kindAgreement})
	require.Len(t, got, 1)
	require.Equal(t, "have", got[0].Replacement)
}

// Defensive: a kinds slice shorter than sugs must not panic; the unmatched
// suggestions are simply treated as non-gateable (kept).
func TestFilterToleratesShortKinds(t *testing.T) {
	const text = "I recieved a café." //nolint:misspell // intentional misspelling under test
	sugs := []correction.Suggestion{
		{Span: correction.Span{Start: 2, End: 10}, Replacement: "received", Model: correction.ModelHarper},
	}
	got := filterLoanwordFalsePositives(text, sugs, nil)
	require.Len(t, got, 1, "no kinds -> nothing gateable -> nothing dropped")
}

func TestIsLoanwordGateable(t *testing.T) {
	require.True(t, isLoanwordGateable(kindSpelling, ""))
	require.True(t, isLoanwordGateable(kindSpelling, "Did you mean to spell `lait` this way?"))
	require.True(t, isLoanwordGateable(kindCapitalization, msgTitleCase))
	require.False(t, isLoanwordGateable(kindCapitalization, msgPronounI), "pronoun-I is a real fix")
	require.False(t, isLoanwordGateable(kindCapitalization, msgSentStart), "sentence-start is a real fix")
	require.False(t, isLoanwordGateable(kindAgreement, "whatever"))
	require.False(t, isLoanwordGateable(lintKindEnhancement, ""))
	require.False(t, isLoanwordGateable("", ""))
}

func TestIsStyleKind(t *testing.T) {
	require.True(t, isStyleKind(lintKindEnhancement))
	require.True(t, isStyleKind(lintKindWordChoice))
	require.True(t, isStyleKind(lintKindStyle))
	require.True(t, isStyleKind(lintKindReadability))
	require.False(t, isStyleKind(kindSpelling))
	require.False(t, isStyleKind(kindCapitalization))
	require.False(t, isStyleKind(kindAgreement))
	require.False(t, isStyleKind(""))
}

func TestTokenizeWordsMarksAccented(t *testing.T) {
	words := tokenizeWords("the café au lait")
	require.Len(t, words, 4)
	require.False(t, words[0].accented) // the
	require.True(t, words[1].accented)  // café
	require.False(t, words[2].accented) // au
	require.False(t, words[3].accented) // lait
}
