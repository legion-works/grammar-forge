package correction

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCompleteCache(t *testing.T) {
	require.Nil(t, newCompleteCache(0), "size 0 => disabled (nil)")

	c := newCompleteCache(2)
	k := completeCacheKey(SourceOpenCode, "Fix the failing test in")
	_, ok := c.get(k)
	require.False(t, ok)

	c.add(k, "the auth module")
	got, ok := c.get(k)
	require.True(t, ok)
	require.Equal(t, "the auth module", got)

	// Source is part of the key: same text, different source → distinct entry
	// (completion is scoped by client, so the cached value must not bleed).
	kBrowser := completeCacheKey(SourceBrowser, "Fix the failing test in")
	require.NotEqual(t, k, kBrowser, "source must change the cache key")
	_, ok = c.get(kBrowser)
	require.False(t, ok, "browser-source key must miss after only opencode was cached")

	// nil receiver is safe (disabled cache).
	var disabled *completeCache
	_, ok = disabled.get(k)
	require.False(t, ok)
	disabled.add(k, "x") // must not panic
}
