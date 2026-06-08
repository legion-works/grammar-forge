package correction

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
)

// Service orchestrates the correction pipeline:
//  1. Run all fast correctors in order (Harper → GECToR). Best-effort: any
//     corrector that errors is logged and skipped.
//  2. Merge/dedup the fast suggestions (greedy by confidence DESC).
//  3. If the policy says escalate, feed the ORIGINAL text to the LLM and
//     replace the result with the diff of the LLM's final output against the
//     ORIGINAL. LLM errors fall back to the fast-path result (logged).
//  4. Log the combined correction (best-effort; log failures are swallowed).
//  5. Tag every returned suggestion with the logged id.
//
// The Service never mutates the text. Clients apply suggestions.
type Service struct {
	pb        PromptBuilder
	fast      []Corrector
	llm       LLMClient
	store     Store
	baseModel string
	policy    EscalationPolicy
	log       *slog.Logger
}

// NewService wires the pipeline. baseModel is recorded on each logged event.
// policy gates when the LLM is consulted; see EscalationPolicy.
func NewService(pb PromptBuilder, fast []Corrector, llm LLMClient, store Store, baseModel string, policy EscalationPolicy) *Service {
	return &Service{
		pb:        pb,
		fast:      fast,
		llm:       llm,
		store:     store,
		baseModel: baseModel,
		policy:    policy,
		log:       slog.Default(),
	}
}

// Correct runs the full pipeline and returns suggestions. It never mutates
// the text. Fast corrector errors and LLM escalation errors are best-effort
// and do not surface to the caller; we always return what we have.
//
// Behaviour by configuration:
//   - len(s.fast) == 0  : legacy LLM-only mode. Always call the LLM.
//   - fast correctors configured : run them, then escalate to the LLM
//     per EscalationPolicy.ShouldEscalate. Low-GECToR-confidence or long
//     input triggers escalation; high-confidence short input is served
//     from the fast path alone.
func (s *Service) Correct(ctx context.Context, req Request) (Correction, error) {
	if len(s.fast) == 0 {
		return s.llmOnly(ctx, req)
	}
	fast := s.runFast(ctx, req)
	all := fast

	if s.llm != nil && s.policy.ShouldEscalate(req.Text, fast) {
		// Feed the LLM the ORIGINAL text, not the fast-path-corrected text.
		// Sequential refinement locked in confident-wrong fast edits the LLM
		// could not revert (GECToR "dogs runs"->"ran", "two mouses"->"mice
		// running"). A capable instruct model corrects the original better
		// than it repairs a corrupted intermediate (spike 2026-06-08: golden
		// residuals fixed 7/7 vs 5/7, 0 clean regressions). We diff the LLM
		// output against the ORIGINAL, so fast-path suggestions are advisory
		// only on escalation. Safe for both model families (chat + GRMR-native
		// both correct raw text).
		llmText, err := s.llm.Complete(ctx, s.pb.Build(req))
		if err != nil {
			s.log.Warn("llm escalation failed; using fast path", "err", err)
		} else {
			all = diffToSuggestions(req.Text, strings.TrimSpace(llmText))
		}
	}

	return s.finalize(ctx, req, all)
}

// llmOnly is the Plan 1B path: always call the LLM, diff, log, return.
// Retained for callers that wire no fast correctors (e.g. CGO_ENABLED=0
// builds that link only the LLM/transport stack).
func (s *Service) llmOnly(ctx context.Context, req Request) (Correction, error) {
	corrected, err := s.llm.Complete(ctx, s.pb.Build(req))
	if err != nil {
		return Correction{}, fmt.Errorf("llm complete: %w", err)
	}
	corrected = strings.TrimSpace(corrected)
	all := diffToSuggestions(req.Text, corrected)
	return s.finalize(ctx, req, all)
}

// finalize logs the combined correction (best-effort) and tags every
// returned suggestion with the logged id.
func (s *Service) finalize(ctx context.Context, req Request, all []Suggestion) (Correction, error) {
	result := Correction{Original: req.Text, Suggestions: all, Score: score(req.Text, all)}
	if len(all) == 0 {
		return result, nil
	}
	id, err := s.store.LogCorrection(ctx, Event{
		Source:     req.Source,
		Original:   req.Text,
		Suggestion: applyAll(req.Text, all),
		Model:      dominantModel(all),
		BaseModel:  s.baseModel,
	})
	if err != nil {
		s.log.Error("log correction failed", "err", err)
		return result, nil
	}
	for i := range result.Suggestions {
		result.Suggestions[i].ID = id
	}
	return result, nil
}

// runFast invokes every fast corrector in order, collects suggestions, and
// returns them deduped/merged. Corrector errors are logged at Warn and
// skipped (best-effort).
func (s *Service) runFast(ctx context.Context, req Request) []Suggestion {
	if len(s.fast) == 0 {
		return nil
	}
	var raw []Suggestion
	for _, c := range s.fast {
		sugs, err := c.Correct(ctx, req)
		if err != nil {
			s.log.Warn("fast corrector failed", "model", c.Name(), "err", err)
			continue
		}
		raw = append(raw, sugs...)
	}
	return mergeSuggestions(raw)
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

// Rephrase asks the LLM to rewrite req.Text for clarity/fluency. It is
// LLM-only (no fast path; rephrase is a chat-model feature and GRMR-V3's
// native format is correction-tuned). Unlike Correct, this method:
//   - surfaces LLM errors to the caller (no best-effort fallback);
//   - does NOT log to the store (rephrase has no signal lifecycle / is not a
//     grammar suggestion to accept-or-reject).
func (s *Service) Rephrase(ctx context.Context, req RephraseRequest) (RephraseResult, error) {
	if s.llm == nil {
		return RephraseResult{}, fmt.Errorf("rephrase requires an llm backend")
	}
	out, err := s.llm.Complete(ctx, s.pb.BuildRephrase(req))
	if err != nil {
		return RephraseResult{}, fmt.Errorf("rephrase: llm complete: %w", err)
	}
	return RephraseResult{
		Original:     req.Text,
		Rephrased:    strings.TrimSpace(out),
		Alternatives: []string{},
	}, nil
}

// applyAll applies suggestions last-to-first so earlier byte offsets stay
// valid as later (higher) spans are replaced.
func applyAll(text string, sugs []Suggestion) string {
	out := text
	for i := len(sugs) - 1; i >= 0; i-- {
		out = sugs[i].Apply(out)
	}
	return out
}

// dominantModel returns the most-frequent Model in sugs. On a tie, ModelLLM
// wins (the LLM is the authoritative source when it ran). Returns "" for
// empty input.
func dominantModel(sugs []Suggestion) Model {
	if len(sugs) == 0 {
		return ""
	}
	counts := make(map[Model]int, len(sugs))
	for _, s := range sugs {
		counts[s.Model]++
	}
	var best Model
	bestN := -1
	for m, n := range counts {
		if n > bestN || (n == bestN && m == ModelLLM) {
			best, bestN = m, n
		}
	}
	return best
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
