package correction

import (
	"crypto/sha256"
	"encoding/hex"
	"sync/atomic"

	lru "github.com/hashicorp/golang-lru/v2"
)

// toneCache memoizes per-text-unit tone tag sets, content-addressed by
// model+text (no TTL: identical model+text always yields identical tags).
// Mirrors sentenceCache, including the atomic hit/miss counters (see
// sentenceCache's doc for why plain atomics rather than a mutex).
type toneCache struct {
	lru          *lru.Cache[string, []ToneTag]
	hits, misses uint64
}

// newToneCache builds a cache with the given capacity. size <= 0 returns nil
// (callers treat a nil cache as disabled).
func newToneCache(size int) *toneCache {
	if size <= 0 {
		return nil
	}
	c, err := lru.New[string, []ToneTag](size)
	if err != nil {
		return nil
	}
	return &toneCache{lru: c}
}

// toneCacheKey derives the content-addressed key (model + text).
func toneCacheKey(model, text string) string {
	h := sha256.New()
	h.Write([]byte(model))
	h.Write([]byte{0})
	h.Write([]byte(text))
	return hex.EncodeToString(h.Sum(nil))
}

func (c *toneCache) get(key string) ([]ToneTag, bool) {
	if c == nil {
		return nil, false
	}
	v, ok := c.lru.Get(key)
	if !ok {
		atomic.AddUint64(&c.misses, 1)
		return nil, false
	}
	atomic.AddUint64(&c.hits, 1)
	out := make([]ToneTag, len(v))
	copy(out, v)
	return out, true
}

func (c *toneCache) add(key string, tags []ToneTag) {
	if c == nil {
		return
	}
	stored := make([]ToneTag, len(tags))
	copy(stored, tags)
	c.lru.Add(key, stored)
}

// stats reports the cumulative hit/miss counts (nil-safe).
func (c *toneCache) stats() (hits, misses uint64) {
	if c == nil {
		return 0, 0
	}
	return atomic.LoadUint64(&c.hits), atomic.LoadUint64(&c.misses)
}
