package correction

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSentenceCacheRoundTrip(t *testing.T) {
	c := newSentenceCache(8)
	sugs := []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelLLM}}
	key := sentenceCacheKey("model-a", "sys", "I has a cat.", "", false)
	c.add(key, sugs)
	got, ok := c.get(key)
	require.True(t, ok)
	require.Equal(t, sugs, got)
}

func TestSentenceCacheReturnsCopies(t *testing.T) {
	c := newSentenceCache(8)
	key := sentenceCacheKey("m", "s", "text", "", false)
	c.add(key, []Suggestion{{Span: Span{0, 1}, Replacement: "X", Model: ModelLLM}})
	a, _ := c.get(key)
	a[0].ID = 999 // caller mutation (finalize tags IDs)
	b, _ := c.get(key)
	require.Equal(t, int64(0), b[0].ID, "cached entries must not be mutated by callers")
}

func TestSentenceCacheKeyVariesOnAllInputs(t *testing.T) {
	base := sentenceCacheKey("m", "sys", "text", "", false)
	require.NotEqual(t, base, sentenceCacheKey("m2", "sys", "text", "", false), "model must vary key")
	require.NotEqual(t, base, sentenceCacheKey("m", "sys2", "text", "", false), "system prompt (personalization) must vary key")
	require.NotEqual(t, base, sentenceCacheKey("m", "sys", "text2", "", false), "sentence must vary key")
	require.NotEqual(t, base, sentenceCacheKey("m", "sys", "text", "", true), "picky must vary key")
}

// Task 6 (GF_LLM_SENTENCE_CONTEXT): the same sentence/system/picky with a
// DIFFERENT ±1 sentence neighbor context must NOT share a cache entry — the
// rendered System prompt only gains a FIXED sentence when context != "" (see
// prompt.Builder.Build), so two different neighbor texts render the SAME
// System but DIFFERENT User content; the key must still diverge.
func TestSentenceCacheKeyVariesOnContext(t *testing.T) {
	base := sentenceCacheKey("m", "sys", "text", "", false)
	require.NotEqual(t, base, sentenceCacheKey("m", "sys", "text", "prev sentence.", false),
		"empty vs non-empty context must vary the key")
	require.NotEqual(t,
		sentenceCacheKey("m", "sys", "text", "prev sentence.", false),
		sentenceCacheKey("m", "sys", "text", "different neighbor.", false),
		"two DIFFERENT non-empty contexts must vary the key even with identical system/sentence/picky")
}

// Two calls with an empty context (the flag-off / whole-text-fallback case)
// must agree on the key — this is the byte-identical-behind-the-flag pin.
func TestSentenceCacheKeyEmptyContextIsStable(t *testing.T) {
	require.Equal(t,
		sentenceCacheKey("m", "sys", "text", "", false),
		sentenceCacheKey("m", "sys", "text", "", false))
}

func TestSentenceCacheCachesEmptyResults(t *testing.T) {
	c := newSentenceCache(8)
	key := sentenceCacheKey("m", "s", "Clean sentence.", "", false)
	c.add(key, nil)
	got, ok := c.get(key)
	require.True(t, ok, "a clean sentence (no suggestions) is the MOST valuable cache entry")
	require.Empty(t, got)
}

func TestSentenceCacheStatsCountsHitsAndMisses(t *testing.T) {
	c := newSentenceCache(8)
	hits, misses := c.stats()
	require.Zero(t, hits)
	require.Zero(t, misses)

	key := sentenceCacheKey("m", "s", "text", "", false)
	_, ok := c.get(key)
	require.False(t, ok)
	hits, misses = c.stats()
	require.EqualValues(t, 0, hits)
	require.EqualValues(t, 1, misses)

	c.add(key, []Suggestion{{Span: Span{0, 1}, Replacement: "X"}})
	_, ok = c.get(key)
	require.True(t, ok, "sentence cache lookup must hit for a just-added key")
	_, ok = c.get(key)
	require.True(t, ok)
	hits, misses = c.stats()
	require.EqualValues(t, 2, hits)
	require.EqualValues(t, 1, misses)
}

func TestSentenceCacheStatsNilSafe(t *testing.T) {
	var c *sentenceCache
	hits, misses := c.stats()
	require.Zero(t, hits)
	require.Zero(t, misses)
}
