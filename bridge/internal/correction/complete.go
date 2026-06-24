package correction

import (
	"context"
	"fmt"
	"strings"
)

// Complete asks the LLM to generate a natural continuation of text. It is
// LLM-only (no fast path; completion is a chat-model feature). Unlike Correct,
// this method:
//   - surfaces LLM errors to the caller (no best-effort fallback);
//   - does NOT log to the store (completion has no signal lifecycle).
func (s *Service) Complete(ctx context.Context, text string, source Source, temperature float64) (string, error) {
	client := s.llm
	if client == nil {
		return "", fmt.Errorf("complete requires an llm backend")
	}
	// Cache hit: identical source+text → return the memoized continuation with
	// no LLM round-trip. Keyed on source because completion is scoped by client.
	// Temperature is NOT part of the key: the fixed seed makes a given input map
	// to one stable continuation, and caching keeps the ghost from flickering to
	// a different completion on each pause for the same text.
	key := completeCacheKey(source, text)
	if cached, ok := s.completeCache.get(key); ok {
		return cached, nil
	}
	prompt := s.pb.BuildComplete(text, source)
	// Resolve the sampling temperature: a positive per-request value overrides
	// the service default; otherwise use the configured completion temperature.
	// A non-zero temperature makes continuations vary across different inputs
	// (correction/rephrase/tone stay greedy via their zero-value Temperature).
	if temperature > 0 {
		prompt.Temperature = temperature
	} else {
		prompt.Temperature = s.completeTemperature
	}
	out, err := client.Complete(ctx, prompt)
	if err != nil {
		return "", fmt.Errorf("complete: llm complete: %w", err)
	}
	result := strings.TrimSpace(out)
	// Only cache non-empty continuations (a transient empty result can be retried).
	if result != "" {
		s.completeCache.add(key, result)
	}
	return result, nil
}
