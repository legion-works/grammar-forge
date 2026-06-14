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

// Stray braces in surrounding prose must not derail extraction. extractJSONObject
// uses a balanced brace scan, so a '{' that never closes (e.g. `{score}` in
// "Result {score}: {...}") is skipped, and a '}' tail after the JSON is
// ignored (the first balanced span ends at the JSON's own '}').
func TestParseToneStrayOpenBraceBeforeJSON(t *testing.T) {
	tags, err := parseToneTags(`Result {score}: {"tags":[{"tag":"direct","confidence":0.5}]}`)
	require.NoError(t, err)
	require.Equal(t, []ToneTag{{"direct", 0.5}}, tags, "stray '{' in prose is tolerated; balanced scan lands on the real JSON")
}

func TestParseToneStrayCloseBraceAfterJSON(t *testing.T) {
	tags, err := parseToneTags(`{"tags":[{"tag":"polite","confidence":0.9}]} see {appendix}`)
	require.NoError(t, err)
	require.Equal(t, []ToneTag{{"polite", 0.9}}, tags, "stray '}' in prose tail is tolerated; first balanced span wins")
}

// REGRESSION: extractJSONObject used to infinite-loop on inputs whose last '{'
// starts a balanced-but-non-JSON span (e.g. a '}' inside a string value that
// closes the naive depth counter early, so the span fails json.Valid and the
// outer loop has no further '{' to advance to). The first version's loop
// update `i = strings.Index(s[i+1:], "{") + i + 1` returned -1+i+1 = i on
// no-further-match, so `i >= 0` stayed true and the loop spun forever. These
// tests guard termination on three pathological inputs and would hang the
// `go test` process on the unfixed code.
func TestParseToneTerminatesOnBraceInString(t *testing.T) {
	// '}' inside the string value "a}b" closes the naive depth counter at
	// the wrong position. The candidate span is invalid; the loop must give
	// up (no further '{' exists) and return "" — soft empty, never a hang.
	_, err := parseToneTags(`{"tags":[{"tag":"a}b","confidence":0.5}]}`)
	require.Error(t, err, "pathological string-quoted '}' yields soft empty")
}

func TestParseToneTerminatesOnUnbalanced(t *testing.T) {
	// No closing brace at all: depth never reaches 0, inner loop falls off
	// the end, outer loop must terminate (no further '{' to try).
	_, err := parseToneTags("prose { with no close")
	require.Error(t, err, "unbalanced '{' yields soft empty")
}

func TestParseToneTerminatesOnAllOpenBraces(t *testing.T) {
	// Multiple open braces, no close. Inner loop falls through; outer loop
	// must terminate after exhausting all '{' candidates.
	_, err := parseToneTags("{{{")
	require.Error(t, err, "all-open-braces input yields soft empty")
}
