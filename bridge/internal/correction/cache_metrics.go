package correction

import "sync/atomic"

// CacheStat is one cache's cumulative hit/miss counts, exposed on /stats so
// an operator can see whether the sentence/tone/complete caches (and the
// singleflight escalation dedup) are actually earning their keep in a live
// deploy, without needing a separate metrics stack.
type CacheStat struct {
	Hits   uint64 `json:"hits"`
	Misses uint64 `json:"misses"`
}

// CacheMetrics is the full concurrency/resilience metrics block surfaced by
// Service.CacheMetrics(). Every field is best-effort/nil-safe: a disabled
// cache (never wired via SetSentenceCache/SetToneCache/SetCompleteCache)
// reports a zero CacheStat, and BreakerState is "" when the configured
// LLMClient does not expose breaker state (see the breakerStater interface
// below — only *llm.Client / *llm.AnthropicClient implement it; the fakes
// used throughout the correction package's own tests do not, and that MUST
// remain a no-op rather than a panic).
type CacheMetrics struct {
	Sentence CacheStat `json:"sentence_cache"`
	Tone     CacheStat `json:"tone_cache"`
	Complete CacheStat `json:"complete_cache"`
	// SingleflightDedup counts every Correct call that piggybacked on an
	// in-flight identical-key correctOnce instead of paying for its own
	// (see Service.sf / Service.sfDedupCount).
	SingleflightDedup uint64 `json:"singleflight_dedup"`
	// LLMBreakerState is "closed" | "open" | "half_open" when the
	// configured LLMClient exposes breaker state, "" otherwise (e.g. no LLM
	// configured, or a test fake).
	LLMBreakerState string `json:"llm_breaker_state,omitempty"`
	// OverEditFirings maps each named over-edit rule's ID (see
	// NamedOverEditRule / DefaultNamedOverEditRules in overedit.go) to how
	// many times it has changed LLM output text since the process started.
	// Rules that have never fired are OMITTED (not zero-valued) so a fresh
	// install or an all-zero run serializes no "overedit_firings" key at
	// all — nil/empty map + omitempty covers both.
	OverEditFirings map[string]uint64 `json:"overedit_firings,omitempty"`
}

// breakerStater is implemented by llm.Client and llm.AnthropicClient (see
// bridge/internal/llm/resilience.go). Declared locally so the correction
// package — which must stay free of any concrete transport import (see
// LLMClient's own doc) — can still opportunistically read breaker state via
// a type assertion, exactly the same pattern SemanticVerifier and the other
// optional-capability interfaces in this package already use.
type breakerStater interface {
	BreakerState() string
}

// CacheMetrics aggregates the sentence/tone/complete cache hit/miss counters,
// the singleflight escalation dedup count, and (best-effort) the configured
// LLM backend's circuit-breaker state, for the /stats surface.
func (s *Service) CacheMetrics() CacheMetrics {
	m := CacheMetrics{
		SingleflightDedup: atomic.LoadUint64(&s.sfDedupCount),
	}
	m.Sentence.Hits, m.Sentence.Misses = s.sentenceCache.stats()
	m.Tone.Hits, m.Tone.Misses = s.toneCache.stats()
	m.Complete.Hits, m.Complete.Misses = s.completeCache.stats()
	if bs, ok := s.llm.(breakerStater); ok {
		m.LLMBreakerState = bs.BreakerState()
	}
	for i, rule := range s.overEditRules {
		count := atomic.LoadUint64(&s.overEditFirings[i])
		if count == 0 {
			continue
		}
		if m.OverEditFirings == nil {
			m.OverEditFirings = make(map[string]uint64, len(s.overEditRules))
		}
		m.OverEditFirings[rule.ID] = count
	}
	return m
}
