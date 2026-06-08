//go:build cgo

package harperffi

import (
	"context"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

// These tests exercise the pure style/word-choice filter with synthetic
// suggestions mirroring real Harper lint output (captured via diagnostic).
// Reuses the msg* constants from loanword_filter_test.go (same package).

const msgVocabEnhance = "Vocabulary enhancement: use `excellent` instead of `very good`"

func TestIsStyleEnhancement(t *testing.T) {
	require.True(t, isStyleEnhancement(msgVocabEnhance))
	require.False(t, isStyleEnhancement(msgSVA))
	require.False(t, isStyleEnhancement(msgSpelling))
	require.False(t, isStyleEnhancement(msgTitleCase))
}

func TestFilterStyleDropsEnhancement(t *testing.T) {
	sugs := []correction.Suggestion{
		{Span: correction.Span{Start: 5, End: 14}, Replacement: "excellent", Message: msgVocabEnhance, Model: correction.ModelHarper},
		{Span: correction.Span{Start: 2, End: 5}, Replacement: "have", Message: msgSVA, Model: correction.ModelHarper},
	}
	got := filterStyleSuggestions(sugs)
	require.Len(t, got, 1)
	require.Equal(t, "have", got[0].Replacement)
}

func TestFilterStyleNoopWhenNoStyle(t *testing.T) {
	sugs := []correction.Suggestion{{Span: correction.Span{Start: 0, End: 1}, Replacement: "I", Message: msgPronounI, Model: correction.ModelHarper}}
	require.Len(t, filterStyleSuggestions(sugs), 1)
}

func TestHarperCorrect_GatesVocabEnhancement_Golden(t *testing.T) {
	h := New()
	defer h.Close()
	got, err := h.Correct(context.Background(), correction.Request{Text: "I am very good at mathematics."})
	require.NoError(t, err)
	for _, s := range got {
		require.NotContains(t, s.Message, "Vocabulary enhancement",
			"style enhancement leaked onto the default path: %q -> %q", s.Message, s.Replacement)
	}
}

func TestHarperCorrect_KeepsRealGrammarError_Golden(t *testing.T) {
	h := New()
	defer h.Close()
	got, err := h.Correct(context.Background(), correction.Request{Text: "I has three cats."})
	require.NoError(t, err)
	require.NotEmpty(t, got, "the SVA error must still be flagged")
}
