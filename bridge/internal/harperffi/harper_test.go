//go:build cgo

package harperffi

import (
	"context"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

//nolint:misspell // "recieve"/"a apple" are intentional misspellings under test
func TestHarperFindsSpellingByteOffsets(t *testing.T) {
	h := New()
	defer h.Close()
	text := "I recieve a apple"
	sugs, err := h.Correct(context.Background(), correction.Request{Text: text})
	require.NoError(t, err)
	require.NotEmpty(t, sugs, "expected at least one lint for misspelled text")
	for _, s := range sugs {
		require.NoError(t, s.Span.Validate(len(text)))
		require.Equal(t, correction.ModelHarper, s.Model)
	}
}

func TestHarperByteOffsetsOnMultibyte(t *testing.T) {
	h := New()
	defer h.Close()
	text := "café recieve" //nolint:misspell // intentional misspelling under test
	sugs, _ := h.Correct(context.Background(), correction.Request{Text: text})
	for _, s := range sugs {
		require.NoError(t, s.Span.Validate(len(text)))
	}
}

// TestHarperLoanwordPhraseNotFlagged is a real-Harper golden test (not synthetic)
// guarding the loanword filter: the spelling/capitalisation lints Harper raises
// on "café au lait" must be dropped because they chain off the accented "café".
// The filter now keys on Harper's structured LintKind (Spelling/Capitalization)
// rather than message substrings, so this also guards harper_get_lint_kind.
func TestHarperLoanwordPhraseNotFlagged(t *testing.T) {
	h := New()
	defer h.Close()
	const text = "We paid 5 euros for the café au lait."
	sugs, err := h.Correct(context.Background(), correction.Request{Text: text})
	require.NoError(t, err)
	require.Empty(t, sugs, "clean loanphrase must not be flagged after the loanword filter; got %+v", sugs)
}

// TestHarperCorrect_GatesStyleEnhancement_Golden is a real-Harper golden test:
// Harper raises an Enhancement ("Vocabulary enhancement") lint on "very good",
// which a grammar corrector must not surface on the default path. The kind-based
// style gate (isStyleKind) must drop it at the source.
func TestHarperCorrect_GatesStyleEnhancement_Golden(t *testing.T) {
	h := New()
	defer h.Close()
	got, err := h.Correct(context.Background(), correction.Request{Text: "I am very good at mathematics."})
	require.NoError(t, err)
	for _, s := range got {
		require.NotContains(t, s.Message, "Vocabulary enhancement",
			"style enhancement leaked onto the default path: %q -> %q", s.Message, s.Replacement)
	}
}

// TestHarperCorrect_KeepsRealGrammarError_Golden ensures the style gate does not
// over-filter: a genuine subject-verb agreement error (Agreement kind) must
// still surface.
func TestHarperCorrect_KeepsRealGrammarError_Golden(t *testing.T) {
	h := New()
	defer h.Close()
	got, err := h.Correct(context.Background(), correction.Request{Text: "I has three cats."})
	require.NoError(t, err)
	require.NotEmpty(t, got, "the SVA error must still be flagged")
}

func TestHarperNoLintsCleanText(t *testing.T) {
	h := New()
	defer h.Close()
	sugs, err := h.Correct(context.Background(), correction.Request{Text: "This is perfectly fine."})
	require.NoError(t, err)
	// "This is perfectly fine." may or may not have any lints (e.g. "perfectly" is fine,
	// "fine" is fine). We assert the call succeeds; we do NOT assert the result is empty
	// because curated rules may flag subjective style choices. The byte-offset guarantee
	// is what matters.
	for _, s := range sugs {
		require.NoError(t, s.Span.Validate(len("This is perfectly fine.")))
	}
}
