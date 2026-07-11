package correction

import (
	"sort"
	"testing"

	"github.com/stretchr/testify/require"
)

// scriptedDiff returns a diffFn stub keyed by the exact candidate string, so
// MajorityEdits tests can pin exact per-candidate edit sets without depending
// on diffmatchpatch's specific diff algorithm output.
func scriptedDiff(script map[string][]Suggestion) func(orig, corrected string) []Suggestion {
	return func(_, corrected string) []Suggestion {
		return script[corrected]
	}
}

func TestMajorityEdits_TwoOfThreeAgreeKeepsMajorityDropsSpurious(t *testing.T) {
	editA := Suggestion{Span: Span{Start: 2, End: 6}, Replacement: "fixed", Replacements: []string{"fixed"}, Model: ModelLLM, Category: CategoryGrammar}
	editBSpurious := Suggestion{Span: Span{Start: 10, End: 14}, Replacement: "oops", Replacements: []string{"oops"}, Model: ModelLLM, Category: CategoryGrammar}
	script := map[string][]Suggestion{
		"cand1": {editA},
		"cand2": {editA},
		"cand3": {editBSpurious},
	}
	out := MajorityEdits("original text", []string{"cand1", "cand2", "cand3"}, scriptedDiff(script))
	require.Len(t, out, 1, "the spurious edit B (1/3 votes) must be dropped; only A (2/3) survives")
	require.Equal(t, editA.Span, out[0].Span)
	require.Equal(t, editA.Replacement, out[0].Replacement)
	require.InDelta(t, 2.0/3.0, out[0].Confidence, 1e-9)
	require.Equal(t, ModelLLM, out[0].Model)
}

func TestMajorityEdits_QuorumTwoDisagreementYieldsEmpty(t *testing.T) {
	editX := Suggestion{Span: Span{Start: 0, End: 3}, Replacement: "xxx"}
	editY := Suggestion{Span: Span{Start: 0, End: 3}, Replacement: "yyy"}
	script := map[string][]Suggestion{
		"cand1": {editX},
		"cand2": {editY},
	}
	out := MajorityEdits("orig", []string{"cand1", "cand2"}, scriptedDiff(script))
	require.Nil(t, out, "n=2, quorum=2: two candidates disagreeing on the same span means NEITHER edit reaches quorum")
}

func TestMajorityEdits_AllEmptyCandidatesReturnsNil(t *testing.T) {
	script := map[string][]Suggestion{"cand1": nil, "cand2": nil, "cand3": nil}
	out := MajorityEdits("orig", []string{"cand1", "cand2", "cand3"}, scriptedDiff(script))
	require.Nil(t, out)
}

func TestMajorityEdits_EmptyCandidateListReturnsNil(t *testing.T) {
	out := MajorityEdits("orig", nil, scriptedDiff(nil))
	require.Nil(t, out)
}

func TestMajorityEdits_VoteConfidenceValues(t *testing.T) {
	edit := Suggestion{Span: Span{Start: 0, End: 1}, Replacement: "a"}
	script := map[string][]Suggestion{
		"c1": {edit}, "c2": {edit}, "c3": {edit}, "c4": {}, "c5": {},
	}
	out := MajorityEdits("orig", []string{"c1", "c2", "c3", "c4", "c5"}, scriptedDiff(script))
	require.Len(t, out, 1)
	require.InDelta(t, 3.0/5.0, out[0].Confidence, 1e-9, "3 of 5 candidates voted for the edit")
}

func TestMajorityEdits_SortedBySpanStart(t *testing.T) {
	editLate := Suggestion{Span: Span{Start: 20, End: 24}, Replacement: "late"}
	editEarly := Suggestion{Span: Span{Start: 0, End: 4}, Replacement: "early"}
	script := map[string][]Suggestion{
		"c1": {editLate, editEarly},
		"c2": {editLate, editEarly},
	}
	out := MajorityEdits("orig", []string{"c1", "c2"}, scriptedDiff(script))
	require.Len(t, out, 2)
	require.True(t, sort.SliceIsSorted(out, func(i, j int) bool { return out[i].Span.Start < out[j].Span.Start }))
	require.Equal(t, 0, out[0].Span.Start)
	require.Equal(t, 20, out[1].Span.Start)
}

// Determinism: fixed per-call seeds (sequential wire) or one seeded request
// (n_param wire) make the whole scheme deterministic for a given input.
// MajorityEdits itself must not introduce nondeterminism (e.g. via
// unordered map iteration leaking into the output order).
func TestMajorityEdits_DeterministicAcrossRuns(t *testing.T) {
	editA := Suggestion{Span: Span{Start: 2, End: 6}, Replacement: "fixed"}
	editB := Suggestion{Span: Span{Start: 10, End: 14}, Replacement: "also"}
	script := map[string][]Suggestion{
		"c1": {editA, editB},
		"c2": {editA, editB},
		"c3": {editA},
	}
	candidates := []string{"c1", "c2", "c3"}
	out1 := MajorityEdits("orig", candidates, scriptedDiff(script))
	out2 := MajorityEdits("orig", candidates, scriptedDiff(script))
	require.Equal(t, out1, out2)
	require.Len(t, out1, 2)
}

// Integration-style: real diffToSuggestions as the diffFn, exercising the
// actual character-diff path rather than a scripted stub.
func TestMajorityEdits_WithRealDiffFn(t *testing.T) {
	original := "I has a cat and he go home."
	candidates := []string{
		"I have a cat and he goes home.",
		"I have a cat and he goes home.",
		"I have a cat and he go home.", // misses the "go"->"goes" fix
	}
	out := MajorityEdits(original, candidates, diffToSuggestions)
	require.NotEmpty(t, out)
	for i := 1; i < len(out); i++ {
		require.LessOrEqual(t, out[i-1].Span.Start, out[i].Span.Start, "result must be sorted by ascending Span.Start")
	}
}
