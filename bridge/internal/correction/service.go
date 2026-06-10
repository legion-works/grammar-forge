package correction

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
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
	pb                     PromptBuilder
	fast                   []Corrector
	llm                    LLMClient
	store                  Store
	baseModel              string
	policy                 EscalationPolicy
	log                    *slog.Logger
	rephraseFactory        RephraseClientFactory
	rephraseDefaultBackend *RephraseBackend
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

// SetRephraseFactory injects the one-shot provider builder used for rephrase
// overrides (and the configured default rephrase backend). Optional; when
// unset, all rephrase calls use the default llm.
func (s *Service) SetRephraseFactory(f RephraseClientFactory) { s.rephraseFactory = f }

// SetRephraseDefaultBackend sets a dedicated default rephrase backend, used when
// a request carries NO override. nil => fall back to the service's default llm.
func (s *Service) SetRephraseDefaultBackend(b *RephraseBackend) { s.rephraseDefaultBackend = b }

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
//
// When req.Picky is true, an additional best-effort style pass runs AFTER
// grammar on BOTH paths and is merged into the result with category="style".
// Finalize (log + tag + score) runs exactly once on the COMBINED set, so
// /signal can reference style suggestions and the logged Event.Suggestion
// reflects the full rewrite.
func (s *Service) Correct(ctx context.Context, req Request) (Correction, error) {
	if len(s.fast) == 0 {
		all, err := s.llmOnlySuggestions(ctx, req)
		if err != nil {
			return Correction{}, err
		}
		if req.Picky {
			all = s.appendStyleSuggestions(ctx, req, all)
		}
		return s.finalize(ctx, req, all)
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
		switch {
		case err != nil:
			s.log.Warn("llm escalation failed; using fast path", "err", err)
		case suspiciouslyTruncated(req.Text, strings.TrimSpace(llmText)):
			// Defense-in-depth behind the client-level finish_reason check:
			// a backend that doesn't report truncation (or any failure mode
			// returning a fraction of the input) must not reach the diff,
			// which would convert the missing tail into mass deletions.
			s.log.Warn("llm output suspiciously short; using fast path",
				"original_bytes", len(req.Text), "llm_bytes", len(strings.TrimSpace(llmText)))
		default:
			// Diff the LLM output, then re-attach Harper's spelling/punctuation
			// categories onto overlapping edits (the diff is otherwise all
			// CategoryGrammar). Display-only; does not change applied text.
			all = propagateFastCategories(diffToSuggestions(req.Text, strings.TrimSpace(llmText)), fast)
		}
	}

	if req.Picky {
		all = s.appendStyleSuggestions(ctx, req, all)
	}

	return s.finalize(ctx, req, all)
}

// appendStyleSuggestions runs the best-effort style pass on top of the
// grammar suggestions and returns the merged slice. Behaviour:
//   - GRMR-native (BuildStyle returns empty User): no-op, grammar returned
//     unchanged. Picky-mode is a chat-model feature; the native format is
//     correction-tuned.
//   - Style LLM error: logged at Warn, grammar returned unchanged. Style
//     is a layer ON TOP of grammar; it must never fail the request.
//   - Any style suggestion whose span overlaps a grammar suggestion is
//     dropped. Grammar is authoritative — when both pipelines want to edit
//     the same byte range, the grammar edit wins.
//   - Style-vs-style overlaps are also deduped (first-by-span-start wins).
//
// The function is pure except for the LLM call and the log; safe to invoke
// from either the LLM-only path or the fast-path-with-escalation path.
func (s *Service) appendStyleSuggestions(ctx context.Context, req Request, grammar []Suggestion) []Suggestion {
	if s.llm == nil {
		return grammar
	}
	p := s.pb.BuildStyle(req)
	if p.User == "" {
		// GRMR-native no-op signal. Picky is a no-op on GRMR-native.
		return grammar
	}
	out, err := s.llm.Complete(ctx, p)
	if err != nil {
		s.log.Warn("style pass failed; grammar only", "err", err)
		return grammar
	}
	if suspiciouslyTruncated(req.Text, strings.TrimSpace(out)) {
		// Truncated style output would diff into style-category mass
		// deletions. Style is best-effort — drop it, keep grammar.
		s.log.Warn("style output suspiciously short; grammar only",
			"original_bytes", len(req.Text), "llm_bytes", len(strings.TrimSpace(out)))
		return grammar
	}
	styled := diffToSuggestionsCategory(req.Text, strings.TrimSpace(out), CategoryStyle)

	// Drop style edits that overlap any grammar edit. Build a span set
	// of grammar suggestions once; O(N*M) is fine for typical N (grammar
	// edits) and M (style edits) — both small.
	var surviving []Suggestion
	for _, ss := range styled {
		overlapsGrammar := false
		for _, gs := range grammar {
			if overlaps(gs.Span, ss.Span) {
				overlapsGrammar = true
				break
			}
		}
		if overlapsGrammar {
			continue
		}
		// Style-vs-style dedup: drop if it overlaps a previously-kept
		// style suggestion (the one with the earlier span start wins,
		// since diffToSuggestions emits ascending-span-start).
		dup := false
		for _, kept := range surviving {
			if overlaps(kept.Span, ss.Span) {
				dup = true
				break
			}
		}
		if !dup {
			surviving = append(surviving, ss)
		}
	}

	if len(surviving) == 0 {
		return grammar
	}
	return append(grammar, surviving...)
}

// llmOnlySuggestions is the no-fast-path branch: call the LLM, diff to
// grammar suggestions, return them WITHOUT logging. The caller (Correct)
// appends any picky style suggestions and finalizes exactly once.
//
// Returning raw suggestions (not a Correction) keeps the SINGLE finalize
// invariant: every request must log and tag exactly one combined set
// (grammar + optional style), so /signal can reference style suggestions
// and the logged Event.Suggestion reflects the full rewrite.
func (s *Service) llmOnlySuggestions(ctx context.Context, req Request) ([]Suggestion, error) {
	corrected, err := s.llm.Complete(ctx, s.pb.Build(req))
	if err != nil {
		return nil, fmt.Errorf("llm complete: %w", err)
	}
	corrected = strings.TrimSpace(corrected)
	if suspiciouslyTruncated(req.Text, corrected) {
		// No fast path to fall back to — surface the truncation as an error
		// rather than diffing it into mass-deletion suggestions.
		return nil, fmt.Errorf("llm output suspiciously short (%d bytes for %d-byte input); discarding",
			len(corrected), len(req.Text))
	}
	return diffToSuggestions(req.Text, corrected), nil
}

// minOriginalLenForTruncationGuard is the input size below which the
// suspiciously-short check is skipped: tiny inputs can legitimately halve
// (e.g. deleting a repeated word in a 3-word fragment), and truncation only
// occurs on inputs long enough to exhaust a token budget.
const minOriginalLenForTruncationGuard = 200

// suspiciouslyTruncated reports whether the LLM output is so much shorter
// than the original that it is more plausibly a truncated/failed generation
// than a real correction. Grammar corrections preserve nearly all content;
// even aggressive edits rarely halve a non-trivial text. Defense-in-depth
// behind the transport-level finish_reason/stop_reason checks (verified
// data-loss bug 2026-06-10: a truncated completion diffed into a 3,591-byte
// deletion suggestion).
func suspiciouslyTruncated(original, corrected string) bool {
	return len(original) >= minOriginalLenForTruncationGuard && len(corrected) < len(original)/2
}

// finalize logs the combined correction (best-effort) and tags every
// returned suggestion with the logged id.
func (s *Service) finalize(ctx context.Context, req Request, all []Suggestion) (Correction, error) {
	// applyAll (used for the logged Event.Suggestion) and clients both
	// assume suggestions are ordered by ascending Span.Start so that
	// last-to-first application keeps earlier byte offsets valid. The
	// grammar-only paths already produce sorted output (mergeSuggestions
	// sorts by span start), so this sort is a no-op for them. The picky
	// style pass appends style edits after grammar edits, which can break
	// the order (a style span earlier than a grammar span) and corrupt
	// the logged combined text and any client that re-applies the result.
	// Sort once here so the precondition is GUARANTEED for every caller,
	// not just the grammar-only path. Stable so equal-start suggestions
	// keep their relative order.
	sort.SliceStable(all, func(i, j int) bool {
		return all[i].Span.Start < all[j].Span.Start
	})
	result := Correction{Original: req.Text, Suggestions: all, Score: score(req.Text, all)}
	if len(all) == 0 {
		return result, nil
	}
	edits := make([]EditRecord, len(all))
	for i, sg := range all {
		original := ""
		if sg.Span.Validate(len(req.Text)) == nil {
			original = req.Text[sg.Span.Start:sg.Span.End]
		}
		edits[i] = EditRecord{
			SpanStart:   sg.Span.Start,
			SpanEnd:     sg.Span.End,
			Original:    original,
			Replacement: sg.Replacement,
			Model:       sg.Model,
			Category:    sg.Category,
			RuleID:      sg.RuleID,
			Confidence:  sg.Confidence,
		}
	}
	_, editIDs, err := s.store.LogCorrection(ctx, Event{
		Source:     req.Source,
		Original:   req.Text,
		Suggestion: applyAll(req.Text, all),
		Model:      dominantModel(all),
		BaseModel:  s.baseModel,
		Edits:      edits,
	})
	if err != nil {
		s.log.Error("log correction failed", "err", err)
		return result, nil
	}
	for i := range result.Suggestions {
		if i < len(editIDs) {
			result.Suggestions[i].ID = editIDs[i]
		}
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
//
// Backend resolution: req.Override (if set AND factory injected) -> configured
// default rephrase backend (if set AND factory injected) -> s.llm. When
// Alternatives>0 the LLM is called up to min(req.Alternatives, 5) times; the
// first non-empty response is the primary, the rest (de-duped) are
// Alternatives. Deterministic backends collapse to 1 variant; acceptable.
func (s *Service) Rephrase(ctx context.Context, req RephraseRequest) (RephraseResult, error) {
	client := s.llm
	switch {
	case req.Override != nil && s.rephraseFactory != nil:
		c, err := s.rephraseFactory(*req.Override)
		if err != nil {
			return RephraseResult{}, fmt.Errorf("rephrase: build override backend: %w", err)
		}
		client = c
	case s.rephraseDefaultBackend != nil && s.rephraseFactory != nil:
		c, err := s.rephraseFactory(*s.rephraseDefaultBackend)
		if err != nil {
			return RephraseResult{}, fmt.Errorf("rephrase: build default backend: %w", err)
		}
		client = c
	}
	if client == nil {
		return RephraseResult{}, fmt.Errorf("rephrase requires an llm backend")
	}
	n := req.Alternatives
	if n < 1 {
		n = 1
	}
	if n > 5 {
		n = 5
	}
	prompt := s.pb.BuildRephrase(req)
	variants := make([]string, 0, n)
	seen := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		out, err := client.Complete(ctx, prompt)
		if err != nil {
			if i == 0 {
				return RephraseResult{}, fmt.Errorf("rephrase: llm complete: %w", err)
			}
			break // best-effort for extra variants
		}
		v := strings.TrimSpace(out)
		if _, dup := seen[v]; dup || v == "" {
			continue
		}
		seen[v] = struct{}{}
		variants = append(variants, v)
	}
	if len(variants) == 0 {
		return RephraseResult{}, fmt.Errorf("rephrase: llm returned no text")
	}
	return RephraseResult{
		Original:     req.Text,
		Rephrased:    variants[0],
		Alternatives: variants[1:],
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
