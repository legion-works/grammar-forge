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
func (s *Service) Complete(ctx context.Context, text string) (string, error) {
	client := s.llm
	if client == nil {
		return "", fmt.Errorf("complete requires an llm backend")
	}
	prompt := s.pb.BuildComplete(text)
	out, err := client.Complete(ctx, prompt)
	if err != nil {
		return "", fmt.Errorf("complete: llm complete: %w", err)
	}
	return strings.TrimSpace(out), nil
}
