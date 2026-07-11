package correction

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

// fakeNBestLLM implements both LLMClient and NBestLLMClient for Task 8
// (GF_LLM_NBEST) service tests. nbestOut/nbestErr script CompleteN;
// completeOut/completeErr script the legacy single Complete call that the
// short-subset fallback and the non-NBest-client fallback both exercise.
// Every call's Prompt.Temperature is recorded so tests can assert the
// N-best temperature reached CompleteN while the untouched (zero) legacy
// temperature reached any fallback Complete call.
type fakeNBestLLM struct {
	mu sync.Mutex

	completeOut   string
	completeErr   error
	completeCalls int
	completeTemps []float64

	nbestOut   []string
	nbestErr   error
	nbestCalls int
	nbestTemps []float64
}

func (f *fakeNBestLLM) Complete(_ context.Context, p Prompt) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.completeCalls++
	f.completeTemps = append(f.completeTemps, p.Temperature)
	return f.completeOut, f.completeErr
}

func (f *fakeNBestLLM) CompleteN(_ context.Context, p Prompt, _ int) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nbestCalls++
	f.nbestTemps = append(f.nbestTemps, p.Temperature)
	return f.nbestOut, f.nbestErr
}

// recordingVerifier is a SemanticVerifier that records the (original,
// corrected) pair it was last asked to score, so tests can assert exactly
// what text the N-best path handed to the gate (Task 8: the highest-vote
// reconstruction, not a losing candidate or a raw un-merged string).
type recordingVerifier struct {
	sim           float64
	err           error
	lastOriginal  string
	lastCorrected string
}

func (r *recordingVerifier) Similarity(_ context.Context, original, corrected string) (float64, error) {
	r.lastOriginal, r.lastCorrected = original, corrected
	return r.sim, r.err
}

// ---- llmOnlySuggestions call site (len(s.fast) == 0) ----

func TestServiceNBest_LLMOnlyPathMergesMajorityVote(t *testing.T) {
	st := &fakeStore{}
	llm := &fakeNBestLLM{nbestOut: []string{
		"I have a cat",
		"I have a cat",
		"I had a cat",
	}}
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	svc.SetNBest(3, 0.4)

	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.NotEmpty(t, got.Suggestions)
	require.Equal(t, "I have a cat", st.lastEvent.Suggestion,
		"the 2/3-vote reconstruction (have) must win over the 1/3 candidate (had)")
	require.Equal(t, 1, llm.nbestCalls)
	require.Equal(t, 0, llm.completeCalls, "a genuine N-best merge must never fall back to the legacy Complete call")
	require.Len(t, llm.nbestTemps, 1)
	require.InDelta(t, 0.4, llm.nbestTemps[0], 1e-9, "CompleteN must be called with the configured N-best temperature")
}

// ---- correctOnce escalation arm (len(s.fast) > 0, low-confidence fast edit) ----

func TestServiceNBest_EscalationArmMergesMajorityVote(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{0, 4}, Replacement: "X", Model: ModelGECToR, Confidence: 0.3}},
	}
	llm := &fakeNBestLLM{nbestOut: []string{
		"I have a cat",
		"I have a cat",
		"I had a cat",
	}}
	svc := NewService(fakePB{}, []Corrector{fc}, llm, st, "m", fastPolicy())
	svc.SetNBest(3, 0.4)

	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.NotEmpty(t, got.Suggestions)
	require.Equal(t, 1, llm.nbestCalls)
	require.Equal(t, 0, llm.completeCalls)
	require.True(t, hasLLMSuggestion(got.Suggestions), "the majority-vote edit must be tagged ModelLLM")
}

// ---- fallback: configured client does not implement NBestLLMClient ----

func TestServiceNBest_NonNBestClientFallsBackToLegacyPathWithoutCrash(t *testing.T) {
	st := &fakeStore{}
	llm := fakeLLM{out: "I have a cat"} // fakeLLM implements ONLY LLMClient, not NBestLLMClient
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	svc.SetNBest(3, 0.4) // SetNBest called, but the configured client can't serve N-best

	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err, "a non-NBestLLMClient must degrade to the legacy single-candidate path, not crash")
	require.Len(t, got.Suggestions, 1)
	require.Equal(t, "I have a cat", st.lastEvent.Suggestion)
}

func TestServiceNBest_NonNBestClientEscalationArmFallsBackWithoutCrash(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{0, 4}, Replacement: "X", Model: ModelGECToR, Confidence: 0.3}},
	}
	llm := fakeLLM{out: "I have a cat"}
	svc := NewService(fakePB{}, []Corrector{fc}, llm, st, "m", fastPolicy())
	svc.SetNBest(3, 0.4)

	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.NotEmpty(t, got.Suggestions)
}

// ---- SHORT-SUBSET FALLBACK ----

func TestServiceNBest_ShortSubsetFallsBackToSingleTemperatureZeroCall(t *testing.T) {
	st := &fakeStore{}
	llm := &fakeNBestLLM{
		nbestOut:    []string{"I have a cat"}, // only 1 of the 3 requested candidates
		completeOut: "I have a cat",
	}
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	svc.SetNBest(3, 0.4)

	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.NotEmpty(t, got.Suggestions)
	require.Equal(t, 1, llm.nbestCalls)
	require.Equal(t, 1, llm.completeCalls,
		"short subset (1 of 3 valid candidates) must fall back to exactly ONE fresh legacy Complete call")
	require.Len(t, llm.completeTemps, 1)
	require.InDelta(t, 0, llm.completeTemps[0], 1e-9,
		"the legacy fallback call must be temperature 0 (the untouched correction default), not the N-best temperature")
}

func TestServiceNBest_ShortSubsetEscalationArmFallsBack(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{0, 4}, Replacement: "X", Model: ModelGECToR, Confidence: 0.3}},
	}
	llm := &fakeNBestLLM{
		nbestOut:    []string{"I have a cat"},
		completeOut: "I have a cat",
	}
	svc := NewService(fakePB{}, []Corrector{fc}, llm, st, "m", fastPolicy())
	svc.SetNBest(3, 0.4)

	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.NotEmpty(t, got.Suggestions)
	require.Equal(t, 1, llm.nbestCalls)
	require.Equal(t, 1, llm.completeCalls)
}

// A CompleteN transport error (0 candidates) is the extreme case of a short
// subset (0 < requested n) and must fall back exactly the same way.
func TestServiceNBest_CompleteNErrorFallsBackToSingleCall(t *testing.T) {
	st := &fakeStore{}
	llm := &fakeNBestLLM{
		nbestErr:    errAlways,
		completeOut: "I have a cat",
	}
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	svc.SetNBest(3, 0.4)

	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.NotEmpty(t, got.Suggestions)
	require.Equal(t, 1, llm.nbestCalls)
	require.Equal(t, 1, llm.completeCalls)
}

// Truncated candidates are rejected by the per-candidate repair chain (the
// same suspiciouslyTruncated guard the single-candidate path uses), so a
// candidate long enough to trip it counts against the short-subset count.
func TestServiceNBest_TruncatedCandidateCountsTowardShortSubset(t *testing.T) {
	longOriginal := strings.Repeat("word ", 60) // 300 bytes >= minOriginalLenForTruncationGuard (200)
	st := &fakeStore{}
	llm := &fakeNBestLLM{
		nbestOut: []string{
			longOriginal, // unchanged -> survives the truncation guard
			"x",          // << half the original length -> suspiciouslyTruncated rejects it
		},
		completeOut: longOriginal,
	}
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	svc.SetNBest(2, 0.4)

	_, err := svc.Correct(context.Background(), Request{Text: longOriginal})
	require.NoError(t, err)
	require.Equal(t, 1, llm.nbestCalls)
	require.Equal(t, 1, llm.completeCalls,
		"1 of 2 candidates truncated -> only 1 valid candidate -> short subset -> legacy fallback")
}

// ---- Semantic-verifier interaction (Task 8 x Phase-C, off in prod but must not crash) ----

func TestServiceNBest_SemanticVerifierScoresHighestVoteReconstruction(t *testing.T) {
	st := &fakeStore{}
	llm := &fakeNBestLLM{nbestOut: []string{
		"I have a cat",
		"I have a cat",
		"I had a cat",
	}}
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	svc.SetNBest(3, 0.4)
	verifier := &recordingVerifier{sim: 0.97}
	svc.SetSemanticVerifier(verifier, 0.80)

	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.NotEmpty(t, got.Suggestions)
	require.Equal(t, "I have a cat", verifier.lastCorrected,
		"the verifier must score the highest-vote (2/3) reconstruction, not the losing 1/3 candidate")
	require.Equal(t, "I has a cat", verifier.lastOriginal)
}

func TestServiceNBest_SemanticVerifierRejectionKeepsFastPathOnEscalation(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Confidence: 0.3}},
	}
	// All 3 candidates unanimously agree on an unrelated rewrite: the merge
	// itself succeeds (3/3 votes), so this exercises the verifier gate
	// specifically, not the short-subset fallback.
	llm := &fakeNBestLLM{nbestOut: []string{
		"Something totally different.",
		"Something totally different.",
		"Something totally different.",
	}}
	svc := NewService(fakePB{}, []Corrector{fc}, llm, st, "m", fastPolicy())
	svc.SetNBest(3, 0.4)
	svc.SetSemanticVerifier(fakeVerifier{sim: 0.10}, 0.80)

	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err, "the N-best x semantic-verifier combination must not crash")
	require.False(t, hasLLMSuggestion(got.Suggestions),
		"a rejected N-best merge must not surface ModelLLM suggestions; the fast-path edit survives")
}

func TestServiceNBest_SemanticVerifierRejectionLLMOnlyYieldsEmpty(t *testing.T) {
	st := &fakeStore{}
	llm := &fakeNBestLLM{nbestOut: []string{
		"Something totally different.",
		"Something totally different.",
		"Something totally different.",
	}}
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	svc.SetNBest(3, 0.4)
	svc.SetSemanticVerifier(fakeVerifier{sim: 0.10}, 0.80)

	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.Empty(t, got.Suggestions, "LLM-only arm rejection yields empty suggestions, mirroring the single-candidate path")
}

// ---- GF_LLM_NBEST default (1) is a no-op: byte-identical legacy behaviour ----

func TestServiceNBest_DefaultOffIsLegacyPath(t *testing.T) {
	st := &fakeStore{}
	llm := &fakeNBestLLM{completeOut: "I have a cat"}
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	// SetNBest is never called: nbestN stays at its zero value (0), which
	// must behave identically to explicitly setting 1 (both fail the `< 2`
	// gate in the tryNBest* helpers).

	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1)
	require.Equal(t, 0, llm.nbestCalls, "CompleteN must never be called when SetNBest was never invoked")
	require.Equal(t, 1, llm.completeCalls)
}
