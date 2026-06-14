package correction

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// helper: build a minimal Suggestion for capitalization tests.
// orig is the word in text at span [start, start+len(orig)).
// repl is the proposed replacement.
// text is accepted but not used in the Suggestion itself (it is the full
// input text passed separately to dropMidSentenceCapitalization).
func capSug(_ string, orig, repl string, start int) Suggestion {
	return Suggestion{
		Span:        Span{Start: start, End: start + len(orig)},
		Replacement: repl,
		Model:       ModelHarper,
	}
}

// ── isTrueSentenceStart ──────────────────────────────────────────────────────

func TestIsTrueSentenceStart_TextStart(t *testing.T) {
	assert.True(t, isTrueSentenceStart("Hello world", 0))
}

func TestIsTrueSentenceStart_AfterPeriod(t *testing.T) {
	text := "End. He"
	// "He" starts at offset 5
	assert.True(t, isTrueSentenceStart(text, 5))
}

func TestIsTrueSentenceStart_AfterExclamation(t *testing.T) {
	text := "Wow! The"
	assert.True(t, isTrueSentenceStart(text, 5))
}

func TestIsTrueSentenceStart_AfterQuestion(t *testing.T) {
	text := "Really? So"
	assert.True(t, isTrueSentenceStart(text, 8))
}

func TestIsTrueSentenceStart_AfterNewline(t *testing.T) {
	text := "Line one.\nThe next"
	// "The" starts at offset 10
	assert.True(t, isTrueSentenceStart(text, 10))
}

func TestIsTrueSentenceStart_AfterComma(t *testing.T) {
	text := "fast food, on the other hand"
	// "on" starts at offset 11
	assert.False(t, isTrueSentenceStart(text, 11))
}

func TestIsTrueSentenceStart_AfterSemicolon(t *testing.T) {
	text := "I went; he stayed"
	// "he" starts at offset 8
	assert.False(t, isTrueSentenceStart(text, 8))
}

func TestIsTrueSentenceStart_AfterWord(t *testing.T) {
	text := "song he is"
	// "he" starts at offset 5
	assert.False(t, isTrueSentenceStart(text, 5))
}

// ── dropMidSentenceCapitalization — POSITIVE (should DROP) ──────────────────

func TestDropMidSentenceCap_OnAfterComma(t *testing.T) {
	// "I eat fast food, on the other hand I like vegetables"
	// Harper suggests on→On at position 17
	text := "I eat fast food, on the other hand I like vegetables"
	s := capSug(text, "on", "On", 17)
	result := dropMidSentenceCapitalization(true, text, []Suggestion{s})
	assert.Empty(t, result, "on→On after comma should be dropped")
}

func TestDropMidSentenceCap_HeAfterComma(t *testing.T) {
	// "Jose is the best song, he is singing well"
	// Harper suggests he→He at position 23
	text := "Jose is the best song, he is singing well"
	s := capSug(text, "he", "He", 23)
	result := dropMidSentenceCapitalization(true, text, []Suggestion{s})
	assert.Empty(t, result, "he→He after comma should be dropped")
}

func TestDropMidSentenceCap_TheAfterSemicolon(t *testing.T) {
	text := "I went; the dog stayed"
	// "the" at offset 8
	s := capSug(text, "the", "The", 8)
	result := dropMidSentenceCapitalization(true, text, []Suggestion{s})
	assert.Empty(t, result, "the→The after semicolon should be dropped")
}

func TestDropMidSentenceCap_SoAfterComma(t *testing.T) {
	text := "It rained, so we stayed"
	// "so" at offset 11
	s := capSug(text, "so", "So", 11)
	result := dropMidSentenceCapitalization(true, text, []Suggestion{s})
	assert.Empty(t, result, "so→So after comma should be dropped")
}

func TestDropMidSentenceCap_AndAfterComma(t *testing.T) {
	text := "We ate, and then left"
	// "and" at offset 8
	s := capSug(text, "and", "And", 8)
	result := dropMidSentenceCapitalization(true, text, []Suggestion{s})
	assert.Empty(t, result, "and→And after comma should be dropped")
}

// ── dropMidSentenceCapitalization — NEGATIVE (must PRESERVE) ────────────────

func TestDropMidSentenceCap_TrueSentenceStart_Period(t *testing.T) {
	// ". He" — true sentence start after period
	text := "She left. He arrived."
	// "He" at offset 10
	s := capSug(text, "he", "He", 10)
	result := dropMidSentenceCapitalization(true, text, []Suggestion{s})
	require.Len(t, result, 1, "He at true sentence start must be preserved")
	assert.Equal(t, "He", result[0].Replacement)
}

func TestDropMidSentenceCap_TrueSentenceStart_TextStart(t *testing.T) {
	// "The cat" — text start
	text := "The cat sat on the mat"
	s := capSug(text, "the", "The", 0)
	result := dropMidSentenceCapitalization(true, text, []Suggestion{s})
	require.Len(t, result, 1, "The at text start must be preserved")
}

func TestDropMidSentenceCap_ProperNounTaipei(t *testing.T) {
	// "In my country, taipei is the capital"
	// taipei→Taipei: "taipei" is NOT in the stoplist → must be preserved
	text := "In my country, taipei is the capital"
	// "taipei" at offset 15
	s := capSug(text, "taipei", "Taipei", 15)
	result := dropMidSentenceCapitalization(true, text, []Suggestion{s})
	require.Len(t, result, 1, "taipei→Taipei (proper noun) must be preserved")
	assert.Equal(t, "Taipei", result[0].Replacement)
}

func TestDropMidSentenceCap_IPronoun(t *testing.T) {
	// "yesterday, i went" — i→I must always be preserved (not in stoplist)
	text := "yesterday, i went to the store"
	// "i" at offset 11
	s := capSug(text, "i", "I", 11)
	result := dropMidSentenceCapitalization(true, text, []Suggestion{s})
	require.Len(t, result, 1, "i→I must always be preserved")
	assert.Equal(t, "I", result[0].Replacement)
}

func TestDropMidSentenceCap_AmbiguousWordBall(t *testing.T) {
	// "the game, ball is round" — ball→Ball: "ball" not in stoplist → preserved
	text := "the game, ball is round"
	// "ball" at offset 10
	s := capSug(text, "ball", "Ball", 10)
	result := dropMidSentenceCapitalization(true, text, []Suggestion{s})
	require.Len(t, result, 1, "ball→Ball (ambiguous/name) must be preserved")
}

func TestDropMidSentenceCap_NonCapitalizationEdit(t *testing.T) {
	// A non-capitalization edit (spelling fix) must be untouched.
	// Note: the misspelling is intentional — it is the test input, not a typo.
	text := "I recieve the package" //nolint:misspell
	s := Suggestion{
		Span:        Span{Start: 2, End: 9},
		Replacement: "receive",
		Model:       ModelHarper,
	}
	result := dropMidSentenceCapitalization(true, text, []Suggestion{s})
	require.Len(t, result, 1, "non-capitalization edit must be preserved")
	assert.Equal(t, "receive", result[0].Replacement)
}

func TestDropMidSentenceCap_FlagDisabled(t *testing.T) {
	// When enabled=false, nothing is filtered even for clear misfires
	text := "I eat fast food, on the other hand"
	s := capSug(text, "on", "On", 17)
	result := dropMidSentenceCapitalization(false, text, []Suggestion{s})
	require.Len(t, result, 1, "disabled flag must be a no-op")
}

func TestDropMidSentenceCap_Idempotent(t *testing.T) {
	// Applying twice should give the same result as applying once
	text := "I eat fast food, on the other hand I like vegetables"
	s1 := capSug(text, "on", "On", 17)
	s2 := capSug(text, "he", "He", 23) // not in this text but offset is fine for test
	suggs := []Suggestion{s1, s2}
	once := dropMidSentenceCapitalization(true, text, suggs)
	// Build a fresh slice for second pass (the function may reuse backing array)
	suggs2 := make([]Suggestion, len(once))
	copy(suggs2, once)
	twice := dropMidSentenceCapitalization(true, text, suggs2)
	assert.Equal(t, once, twice, "idempotent: second pass must not change result")
}

func TestDropMidSentenceCap_EmptyInput(t *testing.T) {
	result := dropMidSentenceCapitalization(true, "", nil)
	assert.Nil(t, result)
}

func TestDropMidSentenceCap_MultiplePreservesNonStoplist(t *testing.T) {
	// Mix: one misfire (on→On) + one proper noun (taipei→Taipei) + one i→I
	// Only the misfire should be dropped; the other two preserved.
	text := "In my country, taipei is the capital, on the other hand, i agree"
	sOn := capSug(text, "on", "On", 38)
	sTaipei := capSug(text, "taipei", "Taipei", 15)
	sI := capSug(text, "i", "I", 57)
	result := dropMidSentenceCapitalization(true, text, []Suggestion{sOn, sTaipei, sI})
	require.Len(t, result, 2, "only the misfire should be dropped")
	assert.Equal(t, "Taipei", result[0].Replacement)
	assert.Equal(t, "I", result[1].Replacement)
}
