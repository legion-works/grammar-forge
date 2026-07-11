package correction

import "sort"

// editKey identifies one candidate edit by its span and replacement text —
// the vote key MajorityEdits groups candidates on. Two candidates propose
// "the same" edit only when they agree on all three; a candidate that shifts
// the span by even one byte, or proposes a different replacement text for an
// otherwise-identical span, is counted as a DIFFERENT vote.
type editKey struct {
	start, end  int
	replacement string
}

// MajorityEdits merges N candidate LLM completions (Task 8, GF_LLM_NBEST)
// into one suggestion set by majority vote. Each candidate is diffed against
// original via diffFn (the caller's existing diffToSuggestions, so every
// vote-eligible edit has already been through the same coalescing/no-op
// cancellation as the single-candidate path); every resulting edit is keyed
// by (Span.Start, Span.End, Replacement); an edit survives only if at least
// quorum candidates independently proposed it, where
// quorum = len(candidates)/2 + 1 (n=2 -> 2, n=3 -> 2, n=5 -> 3 — a strict
// majority, never a tie). A kept suggestion's Confidence is
// votes/len(candidates); Model is forced to ModelLLM (every input edit
// already came from an LLM diff, so this is a no-op in practice, but pins
// the invariant explicitly); Span/Replacement/Replacements/Category/RuleID
// are copied from the first candidate that voted for the key (by
// construction of the key, every voter agrees on Span and Replacement; the
// remaining fields are diffFn-determined and stable across candidates for a
// fixed category/rule set).
//
// The result is sorted by ascending Span.Start, with (Span.End, Replacement)
// as a full tiebreak — editKey is a total order, so two runs over identical
// candidates always produce byte-identical output regardless of Go's
// unordered map iteration used internally.
//
// An empty candidate list, or candidates that all diff to zero edits (every
// candidate agreed the original needed no change), returns nil.
func MajorityEdits(original string, candidates []string, diffFn func(orig, corrected string) []Suggestion) []Suggestion {
	if len(candidates) == 0 {
		return nil
	}
	quorum := len(candidates)/2 + 1

	votes := make(map[editKey]int)
	kept := make(map[editKey]Suggestion)
	for _, cand := range candidates {
		for _, sg := range diffFn(original, cand) {
			key := editKey{start: sg.Span.Start, end: sg.Span.End, replacement: sg.Replacement}
			votes[key]++
			if _, ok := kept[key]; !ok {
				kept[key] = sg
			}
		}
	}

	var out []Suggestion
	for key, n := range votes {
		if n < quorum {
			continue
		}
		sg := kept[key]
		sg.Confidence = float64(n) / float64(len(candidates))
		sg.Model = ModelLLM
		out = append(out, sg)
	}
	if len(out) == 0 {
		return nil
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Span.Start != out[j].Span.Start {
			return out[i].Span.Start < out[j].Span.Start
		}
		if out[i].Span.End != out[j].Span.End {
			return out[i].Span.End < out[j].Span.End
		}
		return out[i].Replacement < out[j].Replacement
	})
	return out
}
