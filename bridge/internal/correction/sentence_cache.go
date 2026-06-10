package correction

import (
	"crypto/sha256"
	"encoding/hex"

	lru "github.com/hashicorp/golang-lru/v2"
)

// sentenceCache memoizes per-sentence suggestion sets (sentence-relative
// spans, NO ids — finalize tags ids per request). Content-addressed: the key
// covers everything that can change the answer (model, full system prompt —
// which embeds the personalization block — the sentence text, and picky), so
// there is no TTL/invalidation machinery. A clean sentence caches an empty
// slice — the dominant steady-state hit while typing.
type sentenceCache struct {
	lru *lru.Cache[string, []Suggestion]
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
func sentenceCacheKey(baseModel, system, sentence string, picky bool) string {
	h := sha256.New()
	h.Write([]byte(baseModel))
	h.Write([]byte{0})
	h.Write([]byte(system))
	h.Write([]byte{0})
	h.Write([]byte(sentence))
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
		return nil, false
	}
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
