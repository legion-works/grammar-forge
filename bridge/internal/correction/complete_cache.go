package correction

import (
	"crypto/sha256"
	"encoding/hex"

	lru "github.com/hashicorp/golang-lru/v2"
)

// completeCache memoizes generative continuations, content-addressed by
// source+text. The source is part of the key because completion is scoped by
// client (OpenCode gets a coding-agent prompt; other clients get prose), so the
// same text yields different continuations per source. No TTL: identical
// source+text always yields the cached continuation. Mirrors toneCache.
//
// Unlike /correct's sentenceCache, completion has no fast path and is a single
// LLM round-trip per request, so caching is the only way to avoid repeated LLM
// calls for an identical prompt (e.g. the user pausing on the same line, or
// distinct clients completing the same boilerplate).
type completeCache struct {
	lru *lru.Cache[string, string]
}

// newCompleteCache builds a cache with the given capacity. size <= 0 returns nil
// (callers treat a nil cache as disabled).
func newCompleteCache(size int) *completeCache {
	if size <= 0 {
		return nil
	}
	c, err := lru.New[string, string](size)
	if err != nil {
		return nil
	}
	return &completeCache{lru: c}
}

// completeCacheKey derives the content-addressed key (source + text).
func completeCacheKey(source Source, text string) string {
	h := sha256.New()
	h.Write([]byte(source))
	h.Write([]byte{0})
	h.Write([]byte(text))
	return hex.EncodeToString(h.Sum(nil))
}

func (c *completeCache) get(key string) (string, bool) {
	if c == nil {
		return "", false
	}
	return c.lru.Get(key)
}

func (c *completeCache) add(key, continuation string) {
	if c == nil {
		return
	}
	c.lru.Add(key, continuation)
}
