package correction

import (
	"crypto/sha256"
	"encoding/hex"
	"sync/atomic"

	lru "github.com/hashicorp/golang-lru/v2"
)

// sentenceCache memoizes per-sentence suggestion sets (sentence-relative
// spans, NO ids — finalize tags ids per request). Content-addressed: the key
// covers everything that can change the answer (model, full system prompt —
// which embeds the personalization block — the sentence text, the ±1
// sentence neighbor context (Task 6), and picky), so there is no
// TTL/invalidation machinery. A clean sentence caches an empty slice — the
// dominant steady-state hit while typing.
type sentenceCache struct {
	lru *lru.Cache[string, []Suggestion]
	// hits/misses are atomic counters surfaced via Stats() for the /stats
	// cache_metrics block (see CacheMetrics in service.go). Plain uint64
	// fields incremented with sync/atomic rather than a mutex: get() is on
	// the hot request path and a counter bump must not add lock contention
	// on top of the LRU's own internal locking.
	hits, misses uint64
}

// newSentenceCache builds a cache with the given entry capacity. size <= 0
// returns nil (callers treat a nil cache as disabled).
func newSentenceCache(size int) *sentenceCache {
	if size <= 0 {
		return nil
	}
	c, err := lru.New[string, []Suggestion](size)
	if err != nil {
		return nil
	}
	return &sentenceCache{lru: c}
}

// sentenceCacheKey derives the content-addressed key. \x00 separators prevent
// ambiguous concatenations ("ab"+"c" vs "a"+"bc").
//
// context (Task 6, GF_LLM_SENTENCE_CONTEXT) is the ±1 sentence neighbor
// context (see neighborContext), hashed UNCONDITIONALLY and separately from
// system: the rendered System prompt gains only a FIXED sentence when
// context != "" (see prompt.Builder.Build), so two requests with the SAME
// sentence/system/picky but DIFFERENT neighbor text would otherwise collide
// on one key even though the LLM sees different User content. Hashing raw
// context (not its presence/absence) keeps different neighbor text from
// sharing a cache entry or singleflight flight. This changes the key layout
// unconditionally (both call sites in service.go pass context — "" on the
// whole-text path, sreq.Context on the segment-loop path), so the in-memory
// LRU and singleflight groups simply repopulate on restart; no migration.
func sentenceCacheKey(baseModel, system, sentence, context string, picky bool) string {
	h := sha256.New()
	h.Write([]byte(baseModel))
	h.Write([]byte{0})
	h.Write([]byte(system))
	h.Write([]byte{0})
	h.Write([]byte(sentence))
	h.Write([]byte{0})
	h.Write([]byte(context))
	h.Write([]byte{0})
	if picky {
		h.Write([]byte{1})
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (c *sentenceCache) get(key string) ([]Suggestion, bool) {
	if c == nil {
		return nil, false
	}
	v, ok := c.lru.Get(key)
	if !ok {
		atomic.AddUint64(&c.misses, 1)
		return nil, false
	}
	atomic.AddUint64(&c.hits, 1)
	out := make([]Suggestion, len(v))
	copy(out, v) // shallow copy: Replacements backing arrays are read-only
	return out, true
}

func (c *sentenceCache) add(key string, sugs []Suggestion) {
	if c == nil {
		return
	}
	stored := make([]Suggestion, len(sugs))
	copy(stored, sugs)
	c.lru.Add(key, stored)
}

// stats reports the cumulative hit/miss counts (nil-safe: a disabled cache
// reports zero for both).
func (c *sentenceCache) stats() (hits, misses uint64) {
	if c == nil {
		return 0, 0
	}
	return atomic.LoadUint64(&c.hits), atomic.LoadUint64(&c.misses)
}
