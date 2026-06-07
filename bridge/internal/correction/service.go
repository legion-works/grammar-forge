package correction

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
)

// Service orchestrates the correction pipeline: build prompt -> call LLM -> diff
// into suggestions -> log -> return. The fast path (Harper/GECToR) is added in
// Plan 1C; for now Correct is LLM-only.
type Service struct {
	pb        PromptBuilder
	llm       LLMClient
	store     Store
	baseModel string
	log       *slog.Logger
}

// NewService wires the pipeline. baseModel is recorded on each logged event.
func NewService(pb PromptBuilder, llm LLMClient, store Store, baseModel string) *Service {
	return &Service{pb: pb, llm: llm, store: store, baseModel: baseModel, log: slog.Default()}
}

// Correct runs the slow path and returns suggestions. It never mutates the text.
func (s *Service) Correct(ctx context.Context, req Request) (Correction, error) {
	corrected, err := s.llm.Complete(ctx, s.pb.Build(req))
	if err != nil {
		return Correction{}, fmt.Errorf("llm complete: %w", err)
	}
	corrected = strings.TrimSpace(corrected)
	suggestions := diffToSuggestions(req.Text, corrected)

	result := Correction{Original: req.Text, Suggestions: suggestions, Score: score(req.Text, suggestions)}
	if len(suggestions) == 0 {
		return result, nil // nothing changed; nothing to log
	}

	id, err := s.store.LogCorrection(ctx, Event{
		Source: req.Source, Original: req.Text, Suggestion: corrected,
		Model: ModelLLM, BaseModel: s.baseModel,
	})
	if err != nil {
		// Logging is best-effort; do not fail the user's request.
		s.log.Error("log correction failed", "err", err)
		return result, nil
	}
	for i := range result.Suggestions {
		result.Suggestions[i].ID = id
	}
	return result, nil
}

// Signal records a user reaction to a logged correction.
func (s *Service) Signal(ctx context.Context, correctionID int64, signal Signal) error {
	switch signal {
	case SignalAccepted, SignalRejected, SignalIgnored:
	default:
		return fmt.Errorf("invalid signal %q", signal)
	}
	return s.store.LogSignal(ctx, correctionID, signal)
}

// CountCorrections exposes the store count for /stats.
func (s *Service) CountCorrections(ctx context.Context) (int64, error) {
	return s.store.CountCorrections(ctx)
}

// score is a coarse 0-100 quality score: fewer/smaller edits => higher score.
func score(original string, suggestions []Suggestion) int {
	if len(suggestions) == 0 {
		return 100
	}
	changed := 0
	for _, s := range suggestions {
		changed += (s.Span.End - s.Span.Start) + len(s.Replacement)
	}
	sc := 100 - (changed*100)/(2*len(original)+1)
	if sc < 0 {
		sc = 0
	}
	return sc
}
