package ltgrpc

import (
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

func TestSuggestionToMatch(t *testing.T) {
	s := correction.Suggestion{
		Span: correction.Span{Start: 2, End: 5}, Replacement: "have",
		Message: "subject-verb agreement", Model: correction.ModelGECToR, Confidence: 0.9,
	}
	m := suggestionToMatch(s)
	require.Equal(t, uint32(2), m.GetOffset())
	require.Equal(t, uint32(3), m.GetLength()) // 5-2
	require.Equal(t, "GF_GECTOR", m.GetId())
	require.NotEmpty(t, m.GetSuggestedReplacements())
	require.Equal(t, "have", m.GetSuggestedReplacements()[0].GetReplacement())
}

func TestSuggestionsToMatchListSkipsZeroWidthDeletes(t *testing.T) {
	// deletion (empty replacement) still maps; pure cosmetic check it doesn't panic
	ml := suggestionsToMatchList([]correction.Suggestion{
		{Span: correction.Span{Start: 0, End: 3}, Replacement: "", Model: correction.ModelHarper},
	})
	require.Len(t, ml.GetMatches(), 1)
}
