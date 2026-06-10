package correction

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSentenceCacheRoundTrip(t *testing.T) {
	c := newSentenceCache(8)
	sugs := []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelLLM}}
	key := sentenceCacheKey("model-a", "sys", "I has a cat.", false)
	c.add(key, sugs)
	got, ok := c.get(key)
	require.True(t, ok)
	require.Equal(t, sugs, got)
}

func TestSentenceCacheReturnsCopies(t *testing.T) {
	c := newSentenceCache(8)
	key := sentenceCacheKey("m", "s", "text", false)
	c.add(key, []Suggestion{{Span: Span{0, 1}, Replacement: "X", Model: ModelLLM}})
	a, _ := c.get(key)
	a[0].ID = 999 // caller mutation (finalize tags IDs)
	b, _ := c.get(key)
	require.Equal(t, int64(0), b[0].ID, "cached entries must not be mutated by callers")
}

func TestSentenceCacheKeyVariesOnAllInputs(t *testing.T) {
	base := sentenceCacheKey("m", "sys", "text", false)
	require.NotEqual(t, base, sentenceCacheKey("m2", "sys", "text", false), "model must vary key")
	require.NotEqual(t, base, sentenceCacheKey("m", "sys2", "text", false), "system prompt (personalization) must vary key")
	require.NotEqual(t, base, sentenceCacheKey("m", "sys", "text2", false), "sentence must vary key")
	require.NotEqual(t, base, sentenceCacheKey("m", "sys", "text", true), "picky must vary key")
}

func TestSentenceCacheCachesEmptyResults(t *testing.T) {
	c := newSentenceCache(8)
	key := sentenceCacheKey("m", "s", "Clean sentence.", false)
	c.add(key, nil)
	got, ok := c.get(key)
	require.True(t, ok, "a clean sentence (no suggestions) is the MOST valuable cache entry")
	require.Empty(t, got)
}
