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
	m := suggestionToMatch("he have it", s)
	require.Equal(t, uint32(2), m.GetOffset())
	require.Equal(t, uint32(3), m.GetLength()) // 5-2
	require.Equal(t, "GF_GECTOR", m.GetId())
	require.NotEmpty(t, m.GetSuggestedReplacements())
	require.Equal(t, "have", m.GetSuggestedReplacements()[0].GetReplacement())
}

func TestSuggestionsToMatchListKeepsDeletes(t *testing.T) {
	// deletion (empty replacement) still maps; pure cosmetic check it doesn't panic
	ml := suggestionsToMatchList("teh cat", []correction.Suggestion{ //nolint:misspell // typo fixture
		{Span: correction.Span{Start: 0, End: 3}, Replacement: "", Model: correction.ModelHarper},
	})
	require.Len(t, ml.GetMatches(), 1)
}

// Regression: LT's GRPCRule throws "Missing message for match with ID <id>" and
// trips the RemoteRule circuit breaker (dropping ALL bridge matches) when a
// Match has an empty description. Only the Harper path sets Suggestion.Message,
// so LLM- and GECToR-sourced matches MUST still get a non-empty description.
func TestSuggestionToMatchAlwaysHasDescription(t *testing.T) {
	for _, model := range []correction.Model{
		correction.ModelLLM, correction.ModelGECToR, correction.ModelHarper, correction.ModelLTRule,
	} {
		s := correction.Suggestion{
			Span: correction.Span{Start: 0, End: 1}, Replacement: "x",
			Model: model, // Message intentionally empty (the LLM/GECToR case)
		}
		m := suggestionToMatch("x text", s)
		require.NotEmpty(t, m.GetMatchDescription(),
			"matchDescription must be non-empty for model %q (LT rejects empty)", model)
		require.NotEmpty(t, m.GetRuleDescription(),
			"ruleDescription must be non-empty for model %q", model)
	}
}

// An explicit Message (Harper path) is still used verbatim as the description.
func TestSuggestionToMatchPreservesMessage(t *testing.T) {
	s := correction.Suggestion{
		Span: correction.Span{Start: 0, End: 1}, Replacement: "x",
		Message: "subject-verb agreement", Model: correction.ModelHarper,
	}
	m := suggestionToMatch("xyz", s)
	require.Equal(t, "subject-verb agreement", m.GetMatchDescription())
}

// Regression: LT's GRPCRule throws "fromPos (N) must be less than toPos (N)" and
// trips the circuit breaker for zero-length matches. Insertions (Span.Start ==
// Span.End) must be widened to a >=1-byte LT span that applies identically.
func TestSuggestionToMatch_InsertionGetsNonZeroLength(t *testing.T) {
	// A "th_e" typo corrected by inserting "e", expressed as a zero-length
	// insertion at byte 24 (the bridge's representation of an insertion).
	const sentence = "I has three cats and teh dog." //nolint:misspell // typo fixture
	s := correction.Suggestion{
		Span: correction.Span{Start: 24, End: 24}, Replacement: "e", Model: correction.ModelLLM,
	}
	m := suggestionToMatch(sentence, s)

	require.Positive(t, m.GetLength(), "LT rejects zero-length matches (fromPos must be < toPos)")
	// Applying LT's (offset,length,replacement) must reproduce the same text as
	// applying the original insertion.
	off, length := int(m.GetOffset()), int(m.GetLength())
	repl := m.GetSuggestedReplacements()[0].GetReplacement()
	ltApplied := sentence[:off] + repl + sentence[off+length:]
	insertionApplied := sentence[:s.Span.Start] + s.Replacement + sentence[s.Span.End:]
	require.Equal(t, insertionApplied, ltApplied)
	require.Equal(t, "I has three cats and tehe dog.", ltApplied) //nolint:misspell // typo fixture
}

// Insertion at the very start of the sentence (no char to the left): widen right.
func TestSuggestionToMatch_InsertionAtStartWidensRight(t *testing.T) {
	const sentence = "ello world"
	s := correction.Suggestion{
		Span: correction.Span{Start: 0, End: 0}, Replacement: "H", Model: correction.ModelLLM,
	}
	m := suggestionToMatch(sentence, s)
	require.Positive(t, m.GetLength())
	off, length := int(m.GetOffset()), int(m.GetLength())
	repl := m.GetSuggestedReplacements()[0].GetReplacement()
	require.Equal(t, "Hello world", sentence[:off]+repl+sentence[off+length:])
}

// Multibyte char to the left of an insertion must not split a UTF-8 rune.
func TestSuggestionToMatch_InsertionRespectsUTF8Boundary(t *testing.T) {
	const sentence = "café" // 'é' is 2 bytes (0xC3 0xA9); len == 5
	// insert "s" at end (byte 5) -> "cafés"
	s := correction.Suggestion{
		Span: correction.Span{Start: len(sentence), End: len(sentence)}, Replacement: "s", Model: correction.ModelLLM,
	}
	m := suggestionToMatch(sentence, s)
	require.Positive(t, m.GetLength())
	off, length := int(m.GetOffset()), int(m.GetLength())
	repl := m.GetSuggestedReplacements()[0].GetReplacement()
	require.Equal(t, "cafés", sentence[:off]+repl+sentence[off+length:])
}
