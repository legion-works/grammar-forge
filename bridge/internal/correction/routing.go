package correction

import (
	"sort"
	"strings"
)

// defaultMinWordsForEscalation is the fallback word count below which an
// empty-fast-path input is treated as trivial and NOT escalated (used when
// EscalationPolicy.MinWordsForEscalation is unset / <= 0).
const defaultMinWordsForEscalation = 3

// EscalationPolicy decides when the fast path is insufficient and the LLM should run.
type EscalationPolicy struct {
	MinConfidence  float64
	MaxSentenceLen int
	// MinWordsForEscalation is the minimum word count for an EMPTY-fast-path
	// input to escalate to the LLM. Harper+GECToR miss whole classes of errors
	// (homophones, confusables, double negatives) and flag nothing, so a
	// non-trivial input with no fast-path suggestion must still consult the LLM.
	// Trivial input (fewer words) is trusted as-is to avoid needless LLM calls.
	MinWordsForEscalation int
	// EscalateOnFastEdit forces escalation whenever the fast path produced any
	// edit, regardless of confidence. Harper lints carry a fixed 0.95
	// confidence, so a confident-but-wrong fast edit (e.g. over-eager
	// rewording) would otherwise bypass the confidence-floor escalation and be
	// served as-is. With this on, the LLM (now fed the ORIGINAL text, see
	// Service.Correct) can override any fast edit. Spike 2026-06-08: turning
	// this on took the golden set from F0.5 0.951 to 1.000 with 0 clean-text
	// false positives. Off by default in code; wired to default ON in config
	// (see config.GF_ESCALATE_ON_FAST_EDIT) — opt-out, not opt-in.
	EscalateOnFastEdit bool
	// SkipLLMForSpellingOnly exempts ALL-spelling fast-path results from the
	// EscalateOnFastEdit trigger: when every fast suggestion is a spelling
	// edit, the fast path is served directly (subject to the confidence floor
	// below) instead of consulting the LLM. Spelling lints come from Harper's
	// dictionary engine — incl. the user dictionary, which the LLM cannot see
	// — and a typo-while-typing answer in ~10-40ms beats a ~300-800ms LLM
	// round-trip. Mixed-category or structural fast edits still escalate.
	// Default OFF (config GF_SKIP_LLM_FOR_SPELLING_ONLY); quality-gated on
	// the full cold golden eval before being relied on.
	SkipLLMForSpellingOnly bool
}

// ShouldEscalate returns true if the input is long, the fast path found nothing
// on non-trivial input, or the best GECToR suggestion is below the confidence
// floor. The floor is checked against GECToR suggestions only — Harper lints
// carry a fixed high confidence (.95) for spelling/style and would mask
// low-confidence structural-error suggestions. When the fast path produced no
// GECToR suggestions (but some Harper ones), the floor is checked against the
// best of all fast suggestions (covers the GECToR-unavailable case).
func (p EscalationPolicy) ShouldEscalate(text string, fast []Suggestion) bool {
	if len([]rune(text)) > p.MaxSentenceLen {
		return true
	}
	if len(fast) == 0 {
		// Nothing flagged: escalate only for non-trivial input so the LLM can
		// catch errors the fast path is blind to, without burning a slow-path
		// call on a one- or two-word fragment.
		return isNonTrivialInput(text, p.MinWordsForEscalation)
	}
	if p.EscalateOnFastEdit {
		// Fast path emitted edits; let the LLM arbitrate from the original
		// (see Service.Correct). Covers confident-but-wrong Harper lints
		// that the confidence floor would otherwise serve as-is. Exception
		// (opt-in): an ALL-spelling fast result is served directly — it
		// falls through to the confidence floor below instead.
		if !p.SkipLLMForSpellingOnly || !allSpellingSuggestions(fast) {
			return true
		}
	}
	gectorScores := make([]float64, 0, len(fast))
	allScores := make([]float64, 0, len(fast))
	for _, s := range fast {
		allScores = append(allScores, s.Confidence)
		if s.Model == ModelGECToR {
			gectorScores = append(gectorScores, s.Confidence)
		}
	}
	pool := gectorScores
	if len(pool) == 0 {
		pool = allScores
	}
	best := 0.0
	for _, c := range pool {
		if c > best {
			best = c
		}
	}
	return best < p.MinConfidence
}

// mergeSuggestions dedups by greedy confidence-DESC: pick the highest-
// confidence suggestion, then keep adding candidates only while they do not
// overlap an already-kept span. After dedup the kept set is sorted by span
// start for deterministic downstream application (apply last-to-first).
// Equal confidence: smaller span wins (more targeted edit is preferred);
// still equal: earlier start wins (stable).
func mergeSuggestions(in []Suggestion) []Suggestion {
	sorted := make([]Suggestion, len(in))
	copy(sorted, in)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Confidence != sorted[j].Confidence {
			return sorted[i].Confidence > sorted[j].Confidence
		}
		// tie: smaller span (more targeted) wins
		iLen := sorted[i].Span.End - sorted[i].Span.Start
		jLen := sorted[j].Span.End - sorted[j].Span.Start
		if iLen != jLen {
			return iLen < jLen
		}
		if pi, pj := categoryPriority(sorted[i].Category), categoryPriority(sorted[j].Category); pi != pj {
			return pi > pj // higher-priority category sorts first → kept on overlap
		}
		// still tied: earlier start
		return sorted[i].Span.Start < sorted[j].Span.Start
	})
	var kept []Suggestion
	for _, s := range sorted {
		overlap := false
		for _, k := range kept {
			if overlaps(k.Span, s.Span) {
				overlap = true
				break
			}
		}
		if !overlap {
			kept = append(kept, s)
		}
	}
	// final pass: sort by span start (stable) for deterministic apply order
	sort.SliceStable(kept, func(i, j int) bool {
		return kept[i].Span.Start < kept[j].Span.Start
	})
	return kept
}

func overlaps(a, b Span) bool { return a.Start < b.End && b.Start < a.End }

// propagateFastCategories re-attaches a specific category (spelling /
// punctuation / typography) from the fast path (Harper) onto the LLM-diff
// suggestions. On escalation the LLM diff REPLACES the fast path, and every
// diff edit is CategoryGrammar (""), so a misspelling the LLM fixed would show
// as "grammar". Harper already classified those words; for each grammar-tagged
// LLM edit that overlaps a non-grammar fast suggestion, adopt the fast
// category. Category is display-only (it never changes the applied text), so
// this is eval-neutral. Edits with no Harper overlap stay CategoryGrammar.
func propagateFastCategories(llm, fast []Suggestion) []Suggestion {
	if len(llm) == 0 || len(fast) == 0 {
		return llm
	}
	for i := range llm {
		if llm[i].Category != CategoryGrammar {
			continue // already specific (or a style edit)
		}
		for _, f := range fast {
			if f.Category == CategoryGrammar {
				continue // grammar/structural fast edit carries no extra signal
			}
			if overlaps(llm[i].Span, f.Span) {
				llm[i].Category = f.Category
				break
			}
		}
	}
	return llm
}

// categoryPriority ranks categories for the overlap tie-breaker: higher wins.
// Used ONLY as a tie-breaker after confidence and span-length, so it never
// preempts the confidence ordering (applied output unchanged → eval-safe).
func categoryPriority(c string) int {
	switch c {
	case CategorySpelling:
		return 5
	case CategoryGrammar: // "" — grammar
		return 4
	case CategoryPunctuation:
		return 3
	case CategoryStyle:
		return 2
	case CategoryTypography:
		return 1
	default: // CategoryUnknown / anything else
		return 0
	}
}

// allSpellingSuggestions reports whether every fast-path suggestion is a
// spelling edit (the SkipLLMForSpellingOnly exemption). False for an empty
// slice — the empty-fast-path branch decides that case.
func allSpellingSuggestions(fast []Suggestion) bool {
	if len(fast) == 0 {
		return false
	}
	for _, s := range fast {
		if s.Category != CategorySpelling {
			return false
		}
	}
	return true
}

// isNonTrivialInput reports whether text has at least minWords whitespace-
// separated words (using defaultMinWordsForEscalation when minWords <= 0). Used
// to gate empty-fast-path LLM escalation so trivial fragments are not escalated.
func isNonTrivialInput(text string, minWords int) bool {
	if minWords <= 0 {
		minWords = defaultMinWordsForEscalation
	}
	return len(strings.Fields(text)) >= minWords
}
