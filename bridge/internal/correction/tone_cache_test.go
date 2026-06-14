package correction

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestToneCache(t *testing.T) {
	require.Nil(t, newToneCache(0), "size 0 => disabled (nil)")

	c := newToneCache(2)
	k := toneCacheKey("m", "hello")
	_, ok := c.get(k)
	require.False(t, ok)

	c.add(k, []ToneTag{{"friendly", 0.9}})
	got, ok := c.get(k)
	require.True(t, ok)
	require.Equal(t, []ToneTag{{"friendly", 0.9}}, got)

	// nil receiver is safe (disabled cache)
	var disabled *toneCache
	_, ok = disabled.get(k)
	require.False(t, ok)
	disabled.add(k, nil) // must not panic
}
