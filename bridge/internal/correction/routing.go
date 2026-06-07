package correction

import "sort"

// EscalationPolicy decides when the fast path is insufficient and the LLM should run.
type EscalationPolicy struct {
	MinConfidence  float64
	MaxSentenceLen int
}

// ShouldEscalate returns true if the input is long, the fast path found
// nothing and the input is long, or the best GECToR suggestion is below the
// confidence floor. The floor is checked against GECToR suggestions only —
// Harper lints carry a fixed high confidence (.95) for spelling/style and
// would mask low-confidence structural-error suggestions. When the fast path
// produced no GECToR suggestions, the floor is checked against the best of
// all fast suggestions (historical behaviour, covers the GECToR-unavailable
// case).
func (p EscalationPolicy) ShouldEscalate(text string, fast []Suggestion) bool {
	if len([]rune(text)) > p.MaxSentenceLen {
		return true
	}
	if len(fast) == 0 {
		return false // nothing flagged on short input: trust the fast path
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
