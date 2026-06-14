package correction

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseToneTags(t *testing.T) {
	clean := `{"tags":[{"tag":"frustrated","confidence":0.8},{"tag":"direct","confidence":0.6}]}`
	tags, err := parseToneTags(clean)
	require.NoError(t, err)
	require.Equal(t, []ToneTag{{"frustrated", 0.8}, {"direct", 0.6}}, tags)

	fenced := "```json\n{\"tags\":[{\"tag\":\"polite\",\"confidence\":1.5}]}\n```"
	tags, err = parseToneTags(fenced)
	require.NoError(t, err)
	require.Equal(t, []ToneTag{{"polite", 1.0}}, tags, "confidence clamped to 1")

	prose := `Sure! Here is the analysis: {"tags":[{"tag":"FRIENDLY","confidence":0.9}]} hope that helps`
	tags, err = parseToneTags(prose)
	require.NoError(t, err)
	require.Equal(t, []ToneTag{{"friendly", 0.9}}, tags, "lowercased + prose-stripped")

	unknown := `{"tags":[{"tag":"bogus","confidence":0.9},{"tag":"neutral","confidence":0.5}]}`
	tags, err = parseToneTags(unknown)
	require.NoError(t, err)
	require.Equal(t, []ToneTag{{"neutral", 0.5}}, tags, "unknown tag dropped")

	empty := `{"tags":[]}`
	tags, err = parseToneTags(empty)
	require.NoError(t, err)
	require.Empty(t, tags)

	_, err = parseToneTags("not json at all")
	require.Error(t, err)
}

// LOCK: extractJSONObject uses first-'{'-to-last-'}' extraction. A stray '{'
// in prose BEFORE the JSON, or a stray '}' in prose AFTER, makes it grab the
// wrong span and the parse fails. The service handles this with a soft-empty
// degradation, but the parser behaviour is the limiting factor — lock it here
// so a future "harden the parser" change is a deliberate, test-visible decision.
func TestParseToneStrayOpenBraceBeforeJSON(t *testing.T) {
	// "Result {score}" is a stray open-brace in prose BEFORE the real JSON.
	// extractJSONObject grabs "{score}: {" which is unbalanced -> parse fails.
	_, err := parseToneTags(`Result {score}: {"tags":[]}`)
	require.Error(t, err, "first-'{'-to-last-'}' grabs the wrong span")
}

func TestParseToneStrayCloseBraceAfterJSON(t *testing.T) {
	// "} see {appendix}" has a stray close-brace AFTER the JSON. The last '}'
	// is in the prose tail, so the grab is unbalanced and parse fails.
	_, err := parseToneTags(`{"tags":[]} see {appendix}`)
	require.Error(t, err, "first-'{'-to-last-'}' grabs the wrong span")
}
