package correction

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/grammarforge/bridge/internal/thesaurus"
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
	// allowlist is the user-dictionary allowlist consulted at finalize time
	// to drop LLM re-flags of words the user has added (the LLM was not
	// given the dictionary, so a confident-wrong fast edit could otherwise
	// be re-emitted on escalation). Optional; nil = no filtering.
	allowlist WordAllowlist
	// overEditRules is the LLM over-edit repair chain (see overedit.go).
	// Applied to the LLM's grammar output BEFORE diffToSuggestions on both
	// LLM paths — text-level repair is load-bearing because the diff can
	// fuse wanted and unwanted edits into one suggestion. nil = no repair
	// (byte-identical legacy behaviour). NOT applied to the style pass or
	// rephrase (intentional rewrites).
	overEditRules []OverEditRule
	// mergeFastEditsMode selects the escalation result composition
	// (GF_MERGE_FAST_EDITS spike). "" (default) = legacy REPLACE semantics:
	// the LLM diff is the whole result and fast-path edits are advisory
	// only. MergeFastEditsGECToR / MergeFastEditsAll = merge-not-replace:
	// fast edits that do not conflict with any LLM edit are appended (the
	// LLM stays authoritative on conflicts), trading precision for recall.
	//
	// MEASURED AND REJECTED (2026-06-10 full cold golden eval): gector mode
	// dropped 125/125 -> 120/125, all mode -> 118/125 (incl. clean-text FPs
	// on code). Two unfixable-by-span-geometry classes: (1) the fast path
	// inserts the same logical token at a DIFFERENT offset than the LLM's
	// equivalent insertion ("listen to to me", "had had already"), and
	// (2) confident-wrong fast edits on spans the LLM correctly left alone
	// ("mice ran"->"running"). Keep "" unless a semantic-equivalence-aware
	// merge is built; re-enabling gates on the full cold eval. See
	// .opencode/specs/2026-06-10-merge-not-replace-spike.md.
	mergeFastEditsMode string
	// fastHintsEnabled toggles GF_FAST_HINTS: when true, the escalation
	// prompt is rendered with Harper's SPELLING candidates as arbitration
	// hints. Default false (zero value). Hints are deterministic per
	// sentence so the sentence-cache key (which hashes only
	// Build(req).System) stays consistent across flag toggles.
	//
	// MEASURED AND REJECTED (2026-06-10 full cold golden eval): hints on
	// dropped 125/125 -> 123/125 — the gibberish-token miss IS fixed, but
	// the appended prompt block perturbed unrelated edits (contraction
	// expansion, a masked lie/lay fix). Keep false; re-enabling gates on
	// the full cold eval. See config.FastHintsEnabled and
	// .opencode/specs/2026-06-10-fast-hint-spike.md.
	fastHintsEnabled bool
	// sentenceCache memoizes per-sentence suggestion sets. nil => legacy
	// whole-text path; populated by SetSentenceCache to enable the sentence
	// pipeline (segment + per-sentence cache lookup + span reassembly).
	sentenceCache *sentenceCache
	// tone analysis (mirrors the rephrase backend resolution; reuses
	// rephraseFactory). toneDefaultBackend is the GF_TONE_* backend (nil =>
	// fall back to the rephrase default, then s.llm). toneCache memoizes tags
	// per text-unit. toneEnabled gates the feature; toneMinChars floors the
	// field path.
	toneDefaultBackend *RephraseBackend
	toneCache          *toneCache
	toneEnabled        bool
	toneMinChars       int
	// completeEnabled gates the /complete endpoint (default false). Mirrors
	// toneEnabled: off until the operator enables it in the deploy compose.
	completeEnabled bool
	// completeCache memoizes continuations per source+text (no fast path on
	// the completion endpoint, so the cache is the only LLM-call elision).
	completeCache *completeCache
	// Synonyms (Moby Thesaurus II, public domain). The thesaurus is loaded
	// once at startup into a frozen lookup map; nil = uninitialised, and
	// the lookup short-circuits to nil without panicking. synonymsEnabled
	// is the GF_SYNONYMS_ENABLED gate; when false the /synonyms endpoint
	// returns an empty array (the route is always on the wire — the gate
	// only controls the payload, not the status code).
	thesaurus       *thesaurus.Thesaurus
	synonymsEnabled bool
	// articleFix enables the deterministic a/an article repair applied to
	// LLM output before diffing (see article.go). Default false (zero value);
	// enabled by SetArticleFix(true) / GF_ARTICLE_FIX=true. Mirrors the
	// overEditRules pattern: text-level repair before diffToSuggestions so
	// the fix fires even when the LLM misses it.
	articleFix bool
	// irregularPluralFix enables the Harper irregular-plural possessive
	// misfire repair (see irregular_plural.go). When true,
	// repairIrregularPluralPossessive is applied to the Harper fast-path
	// suggestions before they are merged, replacing confident-wrong
	// possessive suggestions (tooths→tooth's) with the correct plural
	// (teeth). Default false (zero value); enabled by
	// SetIrregularPluralFix(true) / GF_IRREGULAR_PLURAL_FIX=true (default
	// true in config).
	irregularPluralFix bool
	// capitalizationFix enables the Harper mid-sentence capitalization
	// misfire filter (see capitalization.go). When true,
	// dropMidSentenceCapitalization is applied to the fast-path suggestions
	// per-corrector, dropping capitalization-only edits of unambiguous
	// function words at non-sentence-start positions (e.g. on→On, he→He
	// after a comma). Proper nouns (taipei→Taipei), "i"→"I", and true
	// sentence-start capitalizations are always preserved. Default false
	// (zero value); enabled by SetCapitalizationFix(true) /
	// GF_CAPITALIZATION_FIX=true (default true in config).
	capitalizationFix bool
}

// MergeFastEditsMode values for Service.mergeFastEditsMode
// (config GF_MERGE_FAST_EDITS).
const (
	MergeFastEditsOff    = ""       // legacy replace semantics (default)
	MergeFastEditsGECToR = "gector" // merge non-conflicting GECToR edits only
	MergeFastEditsAll    = "all"    // merge all non-conflicting fast edits
	// *-word variants: conflict is decided on whitespace-delimited WORD
	// zones instead of raw spans, with a zero-width insertion claiming
	// BOTH flanking words. Fixes the span spike's kill class 1 (the same
	// logical insertion at a different offset — "listen to to me") but by
	// construction NOT class 2 (confident-wrong fast edits on words the
	// LLM deliberately left alone). Spike 2026-06-10; gated on the full
	// benchmark ladder.
	MergeFastEditsGECToRWord = "gector-word" // word zones, GECToR edits only
	MergeFastEditsAllWord    = "all-word"    // word zones, all fast edits
)

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

// SetSentenceCache enables the per-sentence pipeline with an LRU of `size`
// sentence entries. Disabled (whole-text behaviour, unchanged) when never
// called or size <= 0.
func (s *Service) SetSentenceCache(size int) { s.sentenceCache = newSentenceCache(size) }

// SetWordAllowlist injects the user-dictionary allowlist consulted at
// finalize time to drop LLM re-flags of words the user has added. Optional;
// nil (zero value) = no filtering.
func (s *Service) SetWordAllowlist(a WordAllowlist) { s.allowlist = a }

// SetOverEditRules injects the LLM over-edit repair chain applied to LLM
// grammar output before diffing (see overedit.go). Optional; nil = no repair.
func (s *Service) SetOverEditRules(rules []OverEditRule) { s.overEditRules = rules }

// SetArticleFix enables or disables the deterministic a/an article repair
// (GF_ARTICLE_FIX). When enabled, applyArticleFixes is applied to the LLM
// output after repairOverEdits and before diffToSuggestions on the escalation
// path, so silent-h corrections ("a honest"→"an honest") fire even when the
// LLM misses them. Default false (zero value); set true in main when
// GF_ARTICLE_FIX is enabled (default true).
func (s *Service) SetArticleFix(enabled bool) { s.articleFix = enabled }

// SetIrregularPluralFix enables or disables the Harper irregular-plural
// possessive misfire repair (GF_IRREGULAR_PLURAL_FIX). When enabled,
// repairIrregularPluralPossessive is applied to the raw Harper suggestions
// before they are merged into the fast-path result, replacing confident-wrong
// possessive suggestions (tooths→tooth's, womans→woman's, luggages→luggage's)
// with the correct plural (teeth, women, luggage). Default false (zero value);
// set true in main when GF_IRREGULAR_PLURAL_FIX is enabled (default true).
func (s *Service) SetIrregularPluralFix(enabled bool) { s.irregularPluralFix = enabled }

// SetCapitalizationFix enables or disables the Harper mid-sentence
// capitalization misfire filter (GF_CAPITALIZATION_FIX). When enabled,
// dropMidSentenceCapitalization is applied to the raw fast-path suggestions
// per-corrector, dropping capitalization-only edits of unambiguous function
// words (e.g. on→On, he→He) at non-sentence-start positions. Proper nouns,
// "i"→"I", and true sentence-start capitalizations are always preserved.
// Default false (zero value); set true in main when GF_CAPITALIZATION_FIX is
// enabled (default true).
func (s *Service) SetCapitalizationFix(enabled bool) { s.capitalizationFix = enabled }

// SetMergeFastEditsMode selects the escalation result composition (see the
// MergeFastEdits* constants). Optional; zero value = legacy replace semantics.
func (s *Service) SetMergeFastEditsMode(mode string) { s.mergeFastEditsMode = mode }

// SetFastHintsEnabled toggles the GF_FAST_HINTS spike: when true and the LLM
// is escalated to, Harper's SPELLING candidates are appended to the chat
// system prompt as arbitration hints. Default false (zero value) so the
// existing eval baseline is unchanged. SPIKE — keep/revert is gated on the
// full cold golden eval. Hints are deterministic per sentence (depend only
// on the fast-path output of the original text), so the sentence-cache key
// (which hashes only Build(req).System, not the rendered-with-hints prompt)
// stays consistent and a flag toggle does not invalidate the cache. The
// empty/all-invalid hints branch is byte-identical to Build(req).
func (s *Service) SetFastHintsEnabled(on bool) { s.fastHintsEnabled = on }

// SetToneDefaultBackend sets the GF_TONE_* default backend (nil => fall back to
// the rephrase default, then s.llm). Resolution reuses the rephrase factory.
func (s *Service) SetToneDefaultBackend(b *RephraseBackend) { s.toneDefaultBackend = b }

// SetToneCache enables the per-text-unit tone cache with the given capacity
// (0 disables). Mirrors the sentence cache wiring.
func (s *Service) SetToneCache(size int) { s.toneCache = newToneCache(size) }

// SetToneConfig sets the enabled gate and the field-path min-chars floor.
func (s *Service) SetToneConfig(enabled bool, minChars int) {
	s.toneEnabled = enabled
	s.toneMinChars = minChars
}

// ToneEnabled reports whether the /tone endpoint is enabled.
func (s *Service) ToneEnabled() bool { return s.toneEnabled }

// SetCompleteEnabled sets the /complete endpoint gate.
func (s *Service) SetCompleteEnabled(enabled bool) { s.completeEnabled = enabled }

// SetCompleteCache enables the per-source+text completion cache with the given
// capacity (0 disables). Mirrors the tone cache wiring.
func (s *Service) SetCompleteCache(size int) { s.completeCache = newCompleteCache(size) }

// CompleteEnabled reports whether the /complete endpoint is enabled.
func (s *Service) CompleteEnabled() bool { return s.completeEnabled }

// SetThesaurus injects the loaded Moby thesaurus. nil is a valid value —
// it disables synonyms without removing the route, mirroring the
// SetDictionary pattern (so the wiring order in main can be linear and
// the dataset being absent at deploy time is a no-op, not a crash).
func (s *Service) SetThesaurus(th *thesaurus.Thesaurus) { s.thesaurus = th }

// SetSynonymsConfig sets the GF_SYNONYMS_ENABLED gate. The thesaurus
// is set separately via SetThesaurus; this flag only controls whether
// the /synonyms endpoint returns a payload.
func (s *Service) SetSynonymsConfig(enabled bool) { s.synonymsEnabled = enabled }

// SynonymsEnabled reports whether the /synonyms endpoint is wired to
// return a non-empty payload.
func (s *Service) SynonymsEnabled() bool { return s.synonymsEnabled }

// Synonyms returns up to 8 case-insensitive synonyms for word from the
// loaded Moby thesaurus. Returns nil for unknown words, a disabled
// feature, or a nil thesaurus — the handler maps all of these to an
// empty JSON array so the response shape is uniform. Errors from the
// lookup are propagated (today the lookup is in-memory and cannot
// fail, but the contract leaves the door open for an out-of-process
// backend later).
func (s *Service) Synonyms(_ context.Context, word string) ([]string, error) {
	if !s.synonymsEnabled {
		return nil, nil
	}
	return s.thesaurus.Lookup(word), nil
}

// spellingHints filters fast-path suggestions down to the CategorySpelling
// entries that the LLM should see as arbitration hints. Other categories
// (grammar, punctuation, style) are not a candidate-fix list and would
// confuse the arbitration prompt. Order is preserved (callers may have
// ordered by confidence DESC); the prompt builder caps the rendered count.
func spellingHints(fast []Suggestion) []Suggestion {
	var out []Suggestion
	for _, sg := range fast {
		if sg.Category == CategorySpelling {
			out = append(out, sg)
		}
	}
	return out
}

// escalationPrompt selects the prompt handed to the LLM in the escalation
// branch. Default: Build(req) (the legacy baseline, byte-identical to
// pre-spike behaviour). GF_FAST_HINTS spike: BuildWithSpellingHints with
// the SPELLING-category fast edits as arbitration hints. The empty/GRMR-
// native branch in the prompt builder keeps the output byte-identical to
// Build(req), so toggling the flag on a no-spelling / GRMR-native input
// does not change the prompt or the sentence-cache key.
func (s *Service) escalationPrompt(req Request, fast []Suggestion) Prompt {
	if s.fastHintsEnabled {
		return s.pb.BuildWithSpellingHints(req, spellingHints(fast))
	}
	return s.pb.Build(req)
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
//
// When req.Picky is true, an additional best-effort style pass runs AFTER
// grammar on BOTH paths and is merged into the result with category="style".
// Finalize (log + tag + score) runs exactly once on the COMBINED set, so
// /signal can reference style suggestions and the logged Event.Suggestion
// reflects the full rewrite.
//
// Sentence path (SetSentenceCache + len(segs) >= 2): split the input into
// sentences, run the single-text pipeline per sentence, serve unchanged
// sentences from the in-process LRU cache, then shift sentence-relative
// spans to whole-text offsets and finalize ONCE on the combined set. The
// truncation guard and the LLM-only error contract both move into
// correctOnce so they apply per-sentence; the aggregate error contract
// ("all N sentences failed" — only surfaces when every single one failed)
// preserves the LLM-only mode's behaviour at the request boundary.
func (s *Service) Correct(ctx context.Context, req Request) (Correction, error) {
	segs := SegmentSentences(req.Text)
	// The per-segment dispatch is decoupled from the cache. The per-segment
	// loop below no-ops the cache when it is nil (sentenceCache.get/add both
	// guard on a nil receiver), so it is safe to run with the cache disabled
	// — each segment is just recomputed. The whole-text fallback is reserved
	// for the single-segment case (len(segs) < 2), where segmenting would
	// not save any work and the legacy whole-text path is faster.
	if len(segs) < 2 {
		all, err := s.correctOnce(ctx, req)
		if err != nil {
			return Correction{}, err
		}
		return s.finalize(ctx, req, all)
	}

	// Sentence path: check each sentence independently, serving unchanged
	// sentences from the cache. Per-sentence errors are best-effort (logged,
	// sentence skipped) UNLESS every sentence failed — then surface one error
	// so the LLM-only mode keeps its error contract.
	var all []Suggestion
	failures := 0
	var lastErr error
	for _, seg := range segs {
		sentence := req.Text[seg.Start:seg.End]
		sreq := Request{Text: sentence, Source: req.Source, Picky: req.Picky}
		key := sentenceCacheKey(s.baseModel, s.pb.Build(sreq).System, sentence, req.Picky)
		sugs, hit := s.sentenceCache.get(key)
		if !hit {
			var err error
			sugs, err = s.correctOnce(ctx, sreq)
			if err != nil {
				failures++
				lastErr = err
				s.log.Warn("sentence check failed; skipping sentence", "err", err)
				continue
			}
			s.sentenceCache.add(key, sugs)
		}
		for i := range sugs {
			sugs[i].Span.Start += seg.Start
			sugs[i].Span.End += seg.Start
		}
		all = append(all, sugs...)
	}
	if failures == len(segs) && lastErr != nil {
		return Correction{}, fmt.Errorf("all %d sentences failed: %w", failures, lastErr)
	}
	return s.finalize(ctx, req, all)
}

// correctOnce runs the full single-text pipeline (fast path, escalation with
// the truncation guard, optional picky style pass) for one unit of text and
// returns raw suggestions. It does NOT log or tag — the caller finalizes
// exactly once per request (sentence path: once on the COMBINED set).
func (s *Service) correctOnce(ctx context.Context, req Request) ([]Suggestion, error) {
	if len(s.fast) == 0 {
		all, err := s.llmOnlySuggestions(ctx, req)
		if err != nil {
			return nil, err
		}
		if req.Picky {
			all = s.appendStyleSuggestions(ctx, req, all)
		}
		return all, nil
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
		llmText, err := s.llm.Complete(ctx, s.escalationPrompt(req, fast))
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
			// The over-edit repair chain runs FIRST (text-level, see
			// overedit.go) so a fused wanted+unwanted edit is fixed before
			// the diff splits it into suggestions.
			repaired := s.repairOverEdits(req.Text, strings.TrimSpace(llmText))
			// Deterministic a/an article fix: applied after over-edit repair
			// and before diffing so silent-h corrections ("a honest"→"an
			// honest") are emitted even when the LLM misses them. Text-level
			// on purpose — mirrors the overedit chain pattern. Gated on
			// GF_ARTICLE_FIX (default true; see article.go).
			if s.articleFix {
				repaired = applyArticleFixes(repaired)
			}
			all = propagateFastCategories(diffToSuggestions(req.Text, repaired), fast)
			// Merge-not-replace spike (GF_MERGE_FAST_EDITS): append fast
			// edits the LLM did not contradict. Off by default — replace
			// semantics above are the measured baseline.
			all = s.mergeNonConflictingFastEdits(req.Text, all, fast)
		}
	}

	if req.Picky {
		all = s.appendStyleSuggestions(ctx, req, all)
	}

	return all, nil
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
	corrected = s.repairOverEdits(req.Text, corrected)
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
	// Drop single-word edits whose span text is in the user-dictionary
	// allowlist. The allowlist guards against the LLM re-flagging a word
	// the user has explicitly added (the LLM was not given the dictionary
	// on escalation). A larger edit that merely contains the word is
	// kept — only single dictionary words are suppressed.
	if s.allowlist != nil && len(all) > 0 {
		all = s.dropAllowlisted(req.Text, all)
	}
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
		// Repair Harper's irregular-plural possessive misfires before merging.
		// Applied per-corrector so the fix fires on Harper's slice before
		// GECToR suggestions are appended (safe: GECToR never emits
		// CategorySpelling, so the filter is a no-op for GECToR output).
		sugs = repairIrregularPluralPossessive(s.irregularPluralFix, sugs)
		// Drop Harper's mid-sentence capitalization misfires (e.g. on→On,
		// he→He after a comma). Proper nouns (taipei→Taipei), "i"→"I", and
		// true sentence-start capitalizations are always preserved. Applied
		// per-corrector for the same reason as repairIrregularPluralPossessive.
		sugs = dropMidSentenceCapitalization(s.capitalizationFix, req.Text, sugs)
		raw = append(raw, sugs...)
	}
	return mergeSuggestions(raw)
}

// CorrectStaged runs the staged pipeline for streaming transports (SSE):
// it computes a fast-path-only PREVIEW (no logging, no edit IDs), hands it
// to onFast incrementally — once per fast corrector as each completes — then
// runs the full Correct pipeline UNCHANGED and returns its result. Each
// onFast call receives the accumulated suggestions from all correctors that
// have completed so far, so the client sees progressively refined previews
// (Harper results first, then Harper+GECToR combined). An empty accumulated
// preview still invokes onFast after the last corrector so clients can clear
// stale state. A nil onFast degrades to plain Correct. The preview applies
// the user-dictionary allowlist (dictionary words must not flash underlines)
// but is NOT logged — /signal cannot reference preview suggestions (IDs are
// zero; clients treat each frame as display-only). Cost: the fast correctors
// run twice per staged request (~10-40ms), the deliberate trade that keeps
// the eval-gated Correct pipeline untouched.
func (s *Service) CorrectStaged(ctx context.Context, req Request, onFast func(Correction)) (Correction, error) {
	if onFast != nil {
		s.runFastIncremental(ctx, req, onFast)
	}
	return s.Correct(ctx, req)
}

// runFastIncremental invokes onFast once per fast corrector, passing the
// accumulated suggestions from all correctors completed so far. When there
// are no fast correctors, onFast is still called once with an empty preview
// so clients can clear stale state. The allowlist is applied to the
// accumulated set before each emission so dictionary words never flash.
func (s *Service) runFastIncremental(ctx context.Context, req Request, onFast func(Correction)) {
	if len(s.fast) == 0 {
		// No fast correctors: emit one empty frame so clients clear stale state.
		onFast(Correction{Original: req.Text, Score: score(req.Text, nil)})
		return
	}
	var accumulated []Suggestion
	for _, c := range s.fast {
		sugs, err := c.Correct(ctx, req)
		if err != nil {
			s.log.Warn("fast corrector failed", "model", c.Name(), "err", err)
			continue
		}
		// Mirror runFast: repair irregular-plural possessive misfires before
		// accumulating so the streaming first frame is also correct.
		sugs = repairIrregularPluralPossessive(s.irregularPluralFix, sugs)
		accumulated = append(accumulated, sugs...)
		preview := mergeSuggestions(accumulated)
		if s.allowlist != nil && len(preview) > 0 {
			preview = s.dropAllowlisted(req.Text, preview)
		}
		onFast(Correction{Original: req.Text, Suggestions: preview, Score: score(req.Text, preview)})
	}
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

// CountSignals exposes the store's edit-signal aggregate for /stats.
func (s *Service) CountSignals(ctx context.Context) (SignalCounts, error) {
	return s.store.CountSignals(ctx)
}

// CountStatsExtended exposes the retention field block (top_issues, streak,
// words_this_week) for /stats. The store computes the per-category
// histogram, the consecutive-day streak, and the 7d word sum from the
// corrections + edits tables; this pass-through just makes it reachable
// from the REST layer. `now` is the reference time the store uses for the
// streak (today) and the 7d window — production passes time.Now(), tests
// pin to a synthetic date.
func (s *Service) CountStatsExtended(ctx context.Context, now time.Time) (StatsExtended, error) {
	return s.store.CountStatsExtended(ctx, now)
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

// AnalyzeTone detects the tone of req.Text. LLM-only; backend resolution:
// req.Override -> tone default (GF_TONE_*) -> rephrase default (GF_REPHRASE_*)
// -> s.llm, all built via the rephrase factory. Tone is advisory: backend/parse
// failures yield empty tags, never an error (unlike Rephrase). Results are
// cached per text-unit. "field" analyzes the whole text (subject to
// ToneMinChars); "sentence" segments via SegmentSentences and analyzes each
// segment, returning per-sentence spans + the aggregated field-level tags.
func (s *Service) AnalyzeTone(ctx context.Context, req ToneRequest) (ToneResult, error) {
	if !s.toneEnabled {
		return ToneResult{Tags: []ToneTag{}}, nil
	}
	client := s.llm
	modelKey := s.baseModel
	switch {
	case req.Override != nil && s.rephraseFactory != nil:
		c, err := s.rephraseFactory(*req.Override)
		if err != nil {
			return ToneResult{}, fmt.Errorf("tone: build override backend: %w", err)
		}
		client, modelKey = c, req.Override.Model
	case s.toneDefaultBackend != nil && s.rephraseFactory != nil:
		c, err := s.rephraseFactory(*s.toneDefaultBackend)
		if err != nil {
			return ToneResult{}, fmt.Errorf("tone: build tone backend: %w", err)
		}
		client, modelKey = c, s.toneDefaultBackend.Model
	case s.rephraseDefaultBackend != nil && s.rephraseFactory != nil:
		c, err := s.rephraseFactory(*s.rephraseDefaultBackend)
		if err != nil {
			return ToneResult{}, fmt.Errorf("tone: build rephrase backend: %w", err)
		}
		client, modelKey = c, s.rephraseDefaultBackend.Model
	}
	if client == nil {
		return ToneResult{}, fmt.Errorf("tone requires an llm backend")
	}
	if req.Granularity == ToneGranularitySentence {
		res := s.analyzeToneSentences(ctx, client, modelKey, req.Text)
		s.logTone(ctx, req.Text, res.Tags, req.Source)
		return res, nil
	}
	if s.toneMinChars > 0 && len(req.Text) < s.toneMinChars {
		return ToneResult{Tags: []ToneTag{}}, nil
	}
	tags := s.toneTagsFor(ctx, client, modelKey, req.Text)
	s.logTone(ctx, req.Text, tags, req.Source)
	return ToneResult{Tags: tags}, nil
}

// logTone best-effort records a tone event (never fails the request). The
// store is optional in tests; when nil, the call is a no-op. Errors are
// logged at Warn so a transient store hiccup degrades to "no signal" rather
// than failing the /tone response.
func (s *Service) logTone(ctx context.Context, text string, tags []ToneTag, src Source) {
	if s.store == nil {
		return
	}
	if err := s.store.LogTone(ctx, ToneEvent{
		TextHash: toneCacheKey("", text), // hash of text only (model-agnostic id)
		Tags:     tags,
		Source:   src,
	}); err != nil {
		s.log.Warn("tone: log signal", "err", err)
	}
}

// toneTagsFor returns the tags for one text unit (cache + soft-error policy).
func (s *Service) toneTagsFor(ctx context.Context, client LLMClient, modelKey, text string) []ToneTag {
	if strings.TrimSpace(text) == "" {
		return []ToneTag{}
	}
	key := toneCacheKey(modelKey, text)
	if cached, ok := s.toneCache.get(key); ok {
		return cached
	}
	prompt := s.pb.BuildTone(ToneRequest{Text: text})
	if prompt.User == "" { // GRMR-native skip signal
		return []ToneTag{}
	}
	out, err := client.Complete(ctx, prompt)
	if err != nil {
		s.log.Warn("tone: llm complete", "err", err)
		return []ToneTag{}
	}
	tags, err := parseToneTags(out)
	if err != nil {
		s.log.Warn("tone: parse", "err", err)
		return []ToneTag{}
	}
	if tags == nil {
		tags = []ToneTag{}
	}
	s.toneCache.add(key, tags)
	return tags
}

// analyzeToneSentences segments text and analyzes each sentence (cached),
// returning per-sentence spans + the aggregated field-level tags.
func (s *Service) analyzeToneSentences(ctx context.Context, client LLMClient, modelKey, text string) ToneResult {
	segs := SegmentSentences(text)
	sentences := make([]ToneSentence, 0, len(segs))
	for _, seg := range segs {
		tags := s.toneTagsFor(ctx, client, modelKey, text[seg.Start:seg.End])
		sentences = append(sentences, ToneSentence{Start: seg.Start, End: seg.End, Tags: tags})
	}
	return ToneResult{Tags: aggregateToneTags(sentences), Sentences: sentences}
}

// aggregateToneTags unions per-sentence tags, keeping the max confidence per
// tag (first-seen order), for the field-level readout on a sentence request.
func aggregateToneTags(sentences []ToneSentence) []ToneTag {
	best := make(map[string]float64)
	order := make([]string, 0)
	for _, sent := range sentences {
		for _, t := range sent.Tags {
			c, ok := best[t.Tag]
			if !ok {
				order = append(order, t.Tag)
			}
			if !ok || t.Confidence > c {
				best[t.Tag] = t.Confidence
			}
		}
	}
	out := make([]ToneTag, 0, len(order))
	for _, tag := range order {
		out = append(out, ToneTag{Tag: tag, Confidence: best[tag]})
	}
	return out
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

// repairOverEdits runs the over-edit rule chain over the LLM output. Pure
// string repair: each rule reverts its over-edit class toward the original
// or returns the text unchanged.
func (s *Service) repairOverEdits(original, corrected string) string {
	for _, rule := range s.overEditRules {
		corrected = rule(original, corrected)
	}
	return corrected
}

// mergeNonConflictingFastEdits implements the merge-not-replace escalation
// composition (GF_MERGE_FAST_EDITS spike): fast-path edits that do not
// CONFLICT with any LLM edit are appended to the LLM result. The LLM stays
// authoritative wherever it edited. Conflict granularity depends on mode:
//   - gector/all: closed-interval SPAN overlap (a touching span counts) —
//     a zero-width fast insertion at the boundary of an LLM edit would
//     otherwise double-apply the same insertion.
//   - gector-word/all-word: whitespace-delimited WORD zones (see
//     wordZonesConflict) — the LLM owns every word it touched, and a
//     zero-width insertion claims both flanking words.
//
// The gector* modes merge only GECToR edits (the structural-recall
// hypothesis); the all* modes also merge Harper edits. Returns llm
// unchanged in MergeFastEditsOff mode. text is the same text the spans
// index into (the per-sentence request text on the sentence path). The
// caller's finalize sorts the combined set by span start, so append order
// is irrelevant.
func (s *Service) mergeNonConflictingFastEdits(text string, llm, fast []Suggestion) []Suggestion {
	if s.mergeFastEditsMode == MergeFastEditsOff || len(fast) == 0 {
		return llm
	}
	gectorOnly := s.mergeFastEditsMode == MergeFastEditsGECToR ||
		s.mergeFastEditsMode == MergeFastEditsGECToRWord
	wordZones := s.mergeFastEditsMode == MergeFastEditsGECToRWord ||
		s.mergeFastEditsMode == MergeFastEditsAllWord
	out := llm
	for _, f := range fast {
		if gectorOnly && f.Model != ModelGECToR {
			continue
		}
		conflict := false
		for _, l := range llm {
			if wordZones {
				conflict = wordZonesConflict(text, l.Span, f.Span)
			} else {
				conflict = spansConflict(l.Span, f.Span)
			}
			if conflict {
				break
			}
		}
		if !conflict {
			out = append(out, f)
		}
	}
	return out
}

// spansConflict is the closed-interval overlap used by the merge: spans
// conflict when they overlap OR touch (shared boundary). Stricter than
// overlaps() on purpose — see mergeNonConflictingFastEdits.
func spansConflict(a, b Span) bool { return a.Start <= b.End && b.Start <= a.End }

// wordZonesConflict reports whether two edits collide at WORD granularity:
// each span is widened to the whitespace-delimited word boundaries it
// touches (a zero-width insertion first claims one byte on each side, so
// an insertion between two words claims BOTH — the measured "listen to to
// me" double-insertion class conflicts here even though the raw spans
// don't touch). Invalid spans conflict unconditionally: an edit the rest
// of the pipeline treats as suspect must never be merged in. The one-byte
// widening can land mid-rune on multibyte text; ExpandToWordBoundaries
// walks byte-wise over non-space runes, so the zone only ever gets WIDER —
// a conservative failure mode (more conflicts, fewer merges).
func wordZonesConflict(text string, a, b Span) bool {
	if a.Validate(len(text)) != nil || b.Validate(len(text)) != nil {
		return true
	}
	za := wordZone(text, a)
	zb := wordZone(text, b)
	return za.Start < zb.End && zb.Start < za.End
}

// wordZone widens a span to the word boundaries it touches; a zero-width
// insertion claims one byte on each side first so it belongs to both
// flanking words. Caller validates the span.
func wordZone(text string, sp Span) Span {
	start, end := sp.Start, sp.End
	if start == end {
		if start > 0 {
			start--
		}
		if end < len(text) {
			end++
		}
	}
	ws, we := ExpandToWordBoundaries(text, start, end)
	return Span{Start: ws, End: we}
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

// dropAllowlisted removes suggestions whose edit falls ENTIRELY within
// allowlisted words (case-insensitive): a single dictionary word, or several
// separated by whitespace — the LLM can merge two adjacent unknown words into
// one edit (verified live), and after the user adds both words that merged
// edit must not be re-emitted. The diff TRIMS the edit's common prefix/suffix,
// so the raw span often covers word FRAGMENTS (verified live: a rewrite of
// two dictionary words sharing a leading/trailing letter); the span is first
// expanded to the surrounding whitespace word boundaries so the fragments
// resolve to the real words. An edit whose expanded text contains ANY
// non-allowlisted token (including punctuation glued to a dictionary word) is
// kept — it is still a real correction. Zero-width spans (pure insertions)
// are never suppressed. Suggestions with invalid spans (e.g. out of bounds)
// are passed through unchanged; Span.Validate is the source of truth and the
// rest of the pipeline is robust to it.
func (s *Service) dropAllowlisted(text string, sugs []Suggestion) []Suggestion {
	out := make([]Suggestion, 0, len(sugs))
	for _, sg := range sugs {
		if sg.Span.Validate(len(text)) == nil && sg.Span.End > sg.Span.Start {
			wordStart, wordEnd := ExpandToWordBoundaries(text, sg.Span.Start, sg.Span.End)
			if allTokensAllowlisted(text[wordStart:wordEnd], s.allowlist) {
				continue
			}
		}
		out = append(out, sg)
	}
	return out
}

// ExpandToWordBoundaries widens a byte span to the surrounding whitespace-
// delimited word boundaries: start walks back to the rune after the previous
// whitespace (or 0), end walks forward to the rune before the next whitespace
// (or len(text)). UTF-8-safe (rune-wise decoding in both directions).
//
// Exported because the store layer reuses it to reconstruct word-level
// personalisation pairs from the span-level diff fragments the corrector
// logs (see store.SQLite.PersonalizationExamples). One concept, one name.
func ExpandToWordBoundaries(text string, start, end int) (int, int) {
	for start > 0 {
		r, size := utf8.DecodeLastRuneInString(text[:start])
		if unicode.IsSpace(r) {
			break
		}
		start -= size
	}
	for end < len(text) {
		r, size := utf8.DecodeRuneInString(text[end:])
		if unicode.IsSpace(r) {
			break
		}
		end += size
	}
	return start, end
}

// allTokensAllowlisted reports whether spanText splits (on whitespace) into
// one or more tokens that are ALL in the allowlist. Empty span text (a pure
// insertion) is never suppressed — there is no word to have allowlisted.
func allTokensAllowlisted(spanText string, allowlist WordAllowlist) bool {
	tokens := strings.Fields(spanText)
	if len(tokens) == 0 {
		return false
	}
	for _, token := range tokens {
		if !allowlist.Contains(token) {
			return false
		}
	}
	return true
}
