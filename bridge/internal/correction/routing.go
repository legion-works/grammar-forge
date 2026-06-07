package correction

import "sort"

// EscalationPolicy decides when the fast path is insufficient and the LLM should run.
type EscalationPolicy struct {
	MinConfidence  float64
	MaxSentenceLen int
}

// ShouldEscalate returns true if input is long, fast path found nothing, or the
// best fast-path suggestion is below the confidence floor.
func (p EscalationPolicy) ShouldEscalate(text string, fast []Suggestion) bool {
	if len([]rune(text)) > p.MaxSentenceLen {
		return true
	}
	if len(fast) == 0 {
		return false // nothing flagged on short input: trust the fast path
	}
	best := 0.0
	for _, s := range fast {
		if s.Confidence > best {
			best = s.Confidence
		}
	}
	return best < p.MinConfidence
}

// mergeSuggestions sorts by span start and drops overlapping duplicates, keeping
// the higher-confidence one (ties: earlier model wins via stable sort).
func mergeSuggestions(in []Suggestion) []Suggestion {
	sort.SliceStable(in, func(i, j int) bool {
		if in[i].Span.Start != in[j].Span.Start {
			return in[i].Span.Start < in[j].Span.Start
		}
		return in[i].Confidence > in[j].Confidence
	})
	var out []Suggestion
	for _, s := range in {
		if n := len(out); n > 0 && overlaps(out[n-1].Span, s.Span) {
			continue // keep the first (higher-confidence due to sort)
		}
		out = append(out, s)
	}
	return out
}

func overlaps(a, b Span) bool { return a.Start < b.End && b.Start < a.End }
