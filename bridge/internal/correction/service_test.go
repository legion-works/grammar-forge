package correction

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/grammarforge/bridge/internal/thesaurus"
	"github.com/stretchr/testify/require"
)

type fakeLLM struct {
	out string
	err error
}

func (f fakeLLM) Complete(context.Context, Prompt) (string, error) { return f.out, f.err }

// llmFunc adapts a function to LLMClient for tests that need per-call output.
type llmFunc func(ctx context.Context, p Prompt) (string, error)

func (f llmFunc) Complete(ctx context.Context, p Prompt) (string, error) { return f(ctx, p) }

type fakePB struct{}

func (fakePB) Build(req Request) Prompt { return Prompt{User: req.Text, Template: TemplateGRMRNative} }

func (fakePB) BuildRephrase(req RephraseRequest) Prompt {
	return Prompt{User: req.Text, Template: TemplateGRMRNative}
}

// BuildStyle is the no-op default (matches the real GRMR-native behaviour):
// picky-mode is a chat-model feature, and the existing tests run on a fake
// that uses the GRMR-native format. Tests that need a chat-style style pass
// override the method on their own fakePB instance.
func (fakePB) BuildStyle(_ Request) Prompt {
	return Prompt{User: "", Template: TemplateGRMRNative}
}

// BuildWithSpellingHints is a no-op for fakePB: fakePB is the GRMR-native
// fake, and GRMR-native takes no system prompt. The real prompt.Builder
// returns Build(req) unchanged on GRMR-native. Tests that need the
// chat-style hint-injection behaviour use spikePB below.
func (fakePB) BuildWithSpellingHints(req Request, _ []Suggestion) Prompt {
	return Prompt{User: req.Text, Template: TemplateGRMRNative}
}

// BuildTone for fakePB: GRMR-native skip signal (empty User) — matches the
// real prompt.Builder behaviour on the GRMR path. Tests that need a chat-style
// tone pass use pickyPB / spikePB.
func (fakePB) BuildTone(_ ToneRequest) Prompt {
	return Prompt{User: "", Template: TemplateGRMRNative}
}

// BuildComplete for fakePB: completion is inherently a chat task, so even on
// the GRMR-native fake we emit a chat_instruct prompt (mirroring the real
// Builder). Tests that care about the complete system prompt use pickyPB.
func (fakePB) BuildComplete(text string, _ Source) Prompt {
	return Prompt{System: "continue", User: text, Template: TemplateChatInstruct}
}

type fakeStore struct {
	// mu guards every field below. Most tests are single-goroutine and never
	// contend on it; the Phase-1b concurrency tests (singleflight dedup,
	// parallel fast path) call Correct from multiple goroutines against the
	// SAME fakeStore, and finalize's LogCorrection call must not race on
	// these plain fields — a real Store implementation (SQLite) handles its
	// own connection-level synchronization, so this mutex just gives the
	// fake the same "safe for concurrent callers" contract.
	mu         sync.Mutex
	lastEvent  Event
	lastSignal Signal
	lastID     int64
	count      int64
	// extendedStats is the canned return for CountStatsExtended (set by
	// the test when it cares about /stats retention fields; the zero
	// value is an empty StatsExtended which is the correct "no data"
	// response).
	extendedStats StatsExtended
}

func (f *fakeStore) LogCorrection(_ context.Context, ev Event) (int64, []int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastEvent = ev
	f.count++
	editIDs := make([]int64, len(ev.Edits))
	for i := range editIDs {
		editIDs[i] = int64(101 + i)
	}
	return 42, editIDs, nil
}

func (f *fakeStore) LogSignal(_ context.Context, id int64, s Signal) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastID, f.lastSignal = id, s
	return nil
}

func (f *fakeStore) LogTone(_ context.Context, _ ToneEvent) error { return nil }
func (f *fakeStore) CountCorrections(context.Context) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.count, nil
}

func (f *fakeStore) CountSignals(context.Context) (SignalCounts, error) {
	return SignalCounts{}, nil
}

func (f *fakeStore) PersonalizationExamples(context.Context) (PersonalizationData, error) {
	return PersonalizationData{}, nil
}

func (f *fakeStore) SignalRates(context.Context) ([]SignalRate, error) {
	return nil, nil
}

func (f *fakeStore) CountStatsExtended(_ context.Context, _ time.Time) (StatsExtended, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.extendedStats, nil
}
func (f *fakeStore) Close() error { return nil }

var errAlways = errors.New("should not be called")

// fastPolicy is the test-default escalation policy. It intentionally leaves
// EscalateOnFastEdit false (the zero value) so existing tests exercise the
// confidence-floor path: high-confidence fast edits are served as-is, low-
// confidence fast edits escalate. Tests that need the on-fast-edit policy
// construct an EscalationPolicy inline. Centralised so the confidence floor
// and max-sentence defaults don't drift between tests.
func fastPolicy() EscalationPolicy { return EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 1000} }

func TestServiceCorrectLogsAndTagsSuggestions(t *testing.T) {
	st := &fakeStore{}
	svc := NewService(fakePB{}, nil, fakeLLM{out: "I have a cat"}, st, "grmr-test", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat", Source: SourceVencord})
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1)
	require.Equal(t, int64(101), got.Suggestions[0].ID) // tagged with the edit id
	require.Equal(t, "I has a cat", st.lastEvent.Original)
	require.Equal(t, "I have a cat", st.lastEvent.Suggestion)
	require.Equal(t, "grmr-test", st.lastEvent.BaseModel)
	require.Equal(t, int64(1), st.count)
}

func TestServiceCorrectNoChangeDoesNotLog(t *testing.T) {
	st := &fakeStore{}
	svc := NewService(fakePB{}, nil, fakeLLM{out: "all good"}, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "all good"})
	require.NoError(t, err)
	require.Empty(t, got.Suggestions)
	require.Equal(t, 100, got.Score)
	require.Equal(t, int64(0), st.count) // nothing to learn from
}

func TestServiceCorrectSurfacesLLMError(t *testing.T) {
	svc := NewService(fakePB{}, nil, fakeLLM{err: errAlways}, &fakeStore{}, "m", fastPolicy())
	_, err := svc.Correct(context.Background(), Request{Text: "x"})
	require.Error(t, err)
}

func TestServiceSignal(t *testing.T) {
	st := &fakeStore{}
	svc := NewService(fakePB{}, nil, fakeLLM{}, st, "m", fastPolicy())
	require.NoError(t, svc.Signal(context.Background(), 7, SignalAccepted))
	require.Equal(t, int64(7), st.lastID)
	require.Equal(t, SignalAccepted, st.lastSignal)
	require.Error(t, svc.Signal(context.Background(), 7, Signal("bogus"))) // invalid enum
}

// failingStore returns an error from LogCorrection — logging is best-effort and
// must not break the user's request.
type failingStore struct {
	fakeStore
}

func (f *failingStore) LogCorrection(context.Context, Event) (int64, []int64, error) {
	return 0, nil, errors.New("db down")
}

func TestServiceCorrectBestEffortLog(t *testing.T) {
	st := &failingStore{}
	svc := NewService(fakePB{}, nil, fakeLLM{out: "I have a cat"}, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err, "logging failure must not surface to the caller")
	require.Len(t, got.Suggestions, 1)
	require.Equal(t, int64(0), got.Suggestions[0].ID, "ID stays zero when log failed")
}

// fast-corrector fake: returns pre-baked suggestions. Proves the Service
// calls Correctors and that escalation policy decides whether to call the LLM.
type fakeCorrector struct {
	name string
	sugs []Suggestion
	err  error
}

func (f fakeCorrector) Name() Model { return Model(f.name) }
func (f fakeCorrector) Correct(context.Context, Request) ([]Suggestion, error) {
	return f.sugs, f.err
}

func TestServiceFastPathNoEscalation(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Confidence: 0.95}},
	}
	// llm that would error if called — proves it is NOT called when fast path is confident.
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{err: errAlways}, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1)
	require.Equal(t, ModelGECToR, got.Suggestions[0].Model)
	require.Equal(t, "I have a cat", st.lastEvent.Suggestion, "fast path must produce the corrected text")
}

// fakeCalibrationStore embeds fakeStore (for the LogCorrection/lastEvent
// capture the calibration tests below assert on) and overrides SignalRates
// so a ConfidenceCalibrator built over the SAME store the service logs to
// can be warmed with a canned bucket. Mirrors fakeRateStore in
// calibration_test.go, minus the single-flight/error knobs this package's
// tests don't need.
type fakeCalibrationStore struct {
	fakeStore
	rates []SignalRate
}

func (f *fakeCalibrationStore) SignalRates(context.Context) ([]SignalRate, error) {
	return f.rates, nil
}

// TestServiceCalibratesDisplayConfidenceAfterLoggingRaw is the core Task-3
// contract: once a warmed calibrator is set, the RESPONSE confidence is the
// calibrated acceptance rate, but the confidence LogCorrection received (the
// edits-table audit trail) stays the raw model-native value. See
// Service.SetConfidenceCalibrator for why that ordering matters.
func TestServiceCalibratesDisplayConfidenceAfterLoggingRaw(t *testing.T) {
	st := &fakeCalibrationStore{
		rates: []SignalRate{{Model: ModelGECToR, Category: CategorySpelling, Accepted: 18, Rejected: 2}},
	}
	cal := NewConfidenceCalibrator(st, time.Minute, 10, slog.Default())
	// Warm the calibrator BEFORE running Correct (see
	// TestCalibratorColdCallFallsBackThenWarms) so the assertions below don't
	// race the background refresh.
	require.Eventually(t, func() bool {
		_, ok := cal.Calibrated(ModelGECToR, CategorySpelling, 0)
		return ok
	}, time.Second, 5*time.Millisecond, "calibrator must warm before the assertions below")

	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Category: CategorySpelling, Confidence: 0.95}},
	}
	// llm that would error if called — the fast edit is confident, so
	// fastPolicy() must not escalate.
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{err: errAlways}, st, "m", fastPolicy())
	svc.SetConfidenceCalibrator(cal)

	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1)

	wantCalibrated := (18.0 + 1) / (18.0 + 2 + 2) // Laplace-smoothed 19/22
	require.InDelta(t, wantCalibrated, got.Suggestions[0].Confidence, 1e-9,
		"response confidence must be the calibrated acceptance rate")

	require.Len(t, st.lastEvent.Edits, 1)
	require.InDelta(t, 0.95, st.lastEvent.Edits[0].Confidence, 1e-9,
		"LogCorrection must receive the RAW confidence, never the calibrator's output")
}

// TestServiceNoCalibratorKeepsRawConfidence is the default-off contract:
// when SetConfidenceCalibrator is never called, the response is untouched —
// byte-identical to pre-Task-3 behaviour.
func TestServiceNoCalibratorKeepsRawConfidence(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Confidence: 0.95}},
	}
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{err: errAlways}, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1)
	require.InDelta(t, 0.95, got.Suggestions[0].Confidence, 1e-9,
		"no calibrator set -> raw confidence must be untouched")
}

// TestServiceCalibratorBelowMinSamplesKeepsRawConfidence: a warmed but
// too-thin bucket (Calibrated returns ok=false) must never overwrite the
// response confidence, mirroring TestCalibratorMinSamplesFallsBack.
func TestServiceCalibratorBelowMinSamplesKeepsRawConfidence(t *testing.T) {
	st := &fakeCalibrationStore{
		rates: []SignalRate{{Model: ModelGECToR, Category: CategorySpelling, Accepted: 3, Rejected: 1}}, // 4 < minSamples(10)
	}
	cal := NewConfidenceCalibrator(st, time.Minute, 10, slog.Default())
	cal.Calibrated(ModelGECToR, CategorySpelling, 0) // kick the background refresh
	require.Never(t, func() bool {
		_, ok := cal.Calibrated(ModelGECToR, CategorySpelling, 0)
		return ok
	}, 200*time.Millisecond, 10*time.Millisecond, "bucket below minSamples must never report ok")

	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Category: CategorySpelling, Confidence: 0.95}},
	}
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{err: errAlways}, st, "m", fastPolicy())
	svc.SetConfidenceCalibrator(cal)

	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1)
	require.InDelta(t, 0.95, got.Suggestions[0].Confidence, 1e-9, "below minSamples -> raw confidence kept")
}

// zeroCallLLM fails the test if Complete is ever called — used to prove the
// escalation calibrator's skip actually elides the LLM round-trip (Task 5).
type zeroCallLLM struct{ t *testing.T }

func (z zeroCallLLM) Complete(context.Context, Prompt) (string, error) {
	z.t.Fatal("LLM must not be called when the escalation calibrator confidently skips")
	return "", nil
}

// TestServiceEscalationCalibratorSkipsLLMKeepsRawConfidence is the Task-5
// contract: SetEscalationCalibrator (ROUTING) is set but SetConfidenceCalibrator
// (DISPLAY) is never called. A fast set that fails the trusted-category check
// but is calibrated-confident (>= MinConfidence) skips the LLM entirely, and
// the response confidence stays the RAW model value — the escalation
// calibrator must never leak into the display path.
func TestServiceEscalationCalibratorSkipsLLMKeepsRawConfidence(t *testing.T) {
	st := &fakeCalibrationStore{
		rates: []SignalRate{{Model: ModelGECToR, Category: CategorySpelling, Accepted: 18, Rejected: 2}},
	}
	cal := NewConfidenceCalibrator(st, time.Minute, 10, slog.Default())
	// Warm the calibrator BEFORE running Correct so the assertions below
	// don't race the background refresh (mirrors
	// TestServiceCalibratesDisplayConfidenceAfterLoggingRaw).
	require.Eventually(t, func() bool {
		_, ok := cal.Calibrated(ModelGECToR, CategorySpelling, 0)
		return ok
	}, time.Second, 5*time.Millisecond, "calibrator must warm before the assertions below")

	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Category: CategorySpelling, Confidence: 0.5}},
	}
	// EscalateOnFastEdit=true with an empty trust set: everyCategoryTrusted
	// fails, so the ONLY way to avoid escalating is the calibrated-skip
	// check. The scripted LLM fails the test if it is ever invoked.
	pol := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 1000, EscalateOnFastEdit: true}
	svc := NewService(fakePB{}, []Corrector{fc}, zeroCallLLM{t: t}, st, "m", pol)
	svc.SetEscalationCalibrator(cal) // routing ONLY — SetConfidenceCalibrator deliberately not called

	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1)
	require.InDelta(t, 0.5, got.Suggestions[0].Confidence, 1e-9,
		"SetEscalationCalibrator must not affect response confidence — that is SetConfidenceCalibrator's job")
}

func TestServiceFastPathEscalatesOnLowGECToRConfidence(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{0, 4}, Replacement: "X", Model: ModelGECToR, Confidence: 0.3}},
	}
	// LLM is called on escalation; it returns a confident replacement.
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{out: "I have a cat"}, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.NotEmpty(t, got.Suggestions)
	require.Equal(t, int64(1), st.count, "escalation must log the combined result")
}

func TestServiceFastPathContinuesOnCorrectorError(t *testing.T) {
	st := &fakeStore{}
	bad := fakeCorrector{name: string(ModelHarper), err: errors.New("native lib missing")}
	good := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Confidence: 0.95}},
	}
	// bad corrector errors; good corrector wins. LLM is NOT called (high conf).
	svc := NewService(fakePB{}, []Corrector{bad, good}, fakeLLM{err: errAlways}, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err, "fast-path corrector errors must be best-effort")
	require.NotEmpty(t, got.Suggestions)
	require.Equal(t, ModelGECToR, got.Suggestions[0].Model)
}

func TestServiceLLMFailureFallsBackToFastPath(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Confidence: 0.3}},
	}
	// Force escalation by low GECToR conf; LLM fails. We must still return the
	// fast-path suggestions rather than an error to the caller.
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{err: errAlways}, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err, "LLM escalation failure must not surface")
	require.NotEmpty(t, got.Suggestions)
	require.Equal(t, ModelGECToR, got.Suggestions[0].Model)
}

// capturingLLM records the prompt it was given so tests can assert what the
// LLM was fed on escalation.
type capturingLLM struct {
	gotPrompt Prompt
	out       string
}

func (c *capturingLLM) Complete(_ context.Context, p Prompt) (string, error) {
	c.gotPrompt = p
	return c.out, nil
}

// On escalation the LLM must receive the ORIGINAL text, not the fast-path-
// corrected text. Sequential refinement locked in confident-wrong fast edits
// the LLM could not revert (spike 2026-06-08: golden residuals fixed 7/7 vs
// 5/7, 0 clean regressions). Final suggestions must still apply against the
// ORIGINAL exactly once — no double edit from parallel fast+LLM corrections.
func TestServiceEscalationFeedsOriginalText(t *testing.T) {
	st := &fakeStore{}
	// GECToR makes a deliberately-wrong low-confidence "cat"->"dogs" edit
	// ([13,16)) -> escalates. Under the old sequential refinement the LLM
	// would have been fed "I have three dogs" (the corrupted intermediate)
	// and could not have reverted the wrong edit. The LLM must see the
	// ORIGINAL "I have three cat" so it can reject the bad fast edit.
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{13, 16}, Replacement: "dogs", Model: ModelGECToR, Confidence: 0.3}},
	}
	// LLM, seeing the ORIGINAL, rejects the wrong fast edit and returns the
	// text unchanged. diffToSuggestions yields an empty suggestion set, which
	// is exactly what we want: the LLM correctly undid the corruption.
	llm := &capturingLLM{out: "I have three cat"}
	svc := NewService(fakePB{}, []Corrector{fc}, llm, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I have three cat"})
	require.NoError(t, err)
	require.Equal(t, "I have three cat", llm.gotPrompt.User,
		"LLM must receive the ORIGINAL text, not the fast-path-corrected text")
	require.Equal(t, "I have three cat", applyAll("I have three cat", got.Suggestions),
		"final suggestions apply once against the original (no double edit)")
}

func TestApplyAllAndDominantModel(t *testing.T) {
	// applyAll applies last-to-first. Same-length replacements so earlier
	// byte offsets stay valid through the apply.
	sugs := []Suggestion{
		{Span: Span{6, 11}, Replacement: "earth", Model: ModelGECToR, Confidence: 0.9},
		{Span: Span{0, 5}, Replacement: "howdy", Model: ModelLLM, Confidence: 0.8},
	}
	out := applyAll("hello world", sugs)
	require.Equal(t, "howdy earth", out, "applyAll applies last-to-first")
	// dominant: LLM appears once, GECToR once; LLM wins on tie-break.
	require.Equal(t, ModelLLM, dominantModel(sugs))
	// LLM-heavy wins outright
	require.Equal(t, ModelLLM, dominantModel([]Suggestion{
		{Model: ModelLLM}, {Model: ModelLLM}, {Model: ModelGECToR},
	}))
}

// Rephrase is LLM-only. The fast path / grammar pipeline must NOT run, the
// store must NOT be logged to, and the result's Original must be the
// unmodified input text.
func TestServiceRephraseHappyPath(t *testing.T) {
	st := &fakeStore{}
	svc := NewService(fakePB{}, nil, fakeLLM{out: "a rewrite"}, st, "m", fastPolicy())
	got, err := svc.Rephrase(context.Background(), RephraseRequest{Text: "He go to store.", Source: SourceVencord})
	require.NoError(t, err)
	require.Equal(t, "He go to store.", got.Original)
	require.Equal(t, "a rewrite", got.Rephrased)
	require.Empty(t, got.Alternatives, "Alternatives is reserved; must be empty")
	require.Equal(t, int64(0), st.count, "rephrase must NOT log to the store")
}

// LLM backend failure must surface to the caller (unlike Correct's best-effort
// fast-path fallback): rephrase is LLM-only, so a backend error is a 502.
func TestServiceRephraseLLMError(t *testing.T) {
	st := &fakeStore{}
	svc := NewService(fakePB{}, nil, fakeLLM{err: errAlways}, st, "m", fastPolicy())
	_, err := svc.Rephrase(context.Background(), RephraseRequest{Text: "x"})
	require.Error(t, err)
	require.Equal(t, int64(0), st.count, "rephrase must NOT log on backend error")
}

// A Service with no LLM backend is a misconfiguration for rephrase. Surface a
// clear error rather than silently producing a Suggestion for the original
// text or panicking on nil deref.
func TestServiceRephraseNilLLM(t *testing.T) {
	st := &fakeStore{}
	svc := NewService(fakePB{}, nil, nil, st, "m", fastPolicy())
	_, err := svc.Rephrase(context.Background(), RephraseRequest{Text: "x"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "llm")
}

func TestRephraseUsesOverrideAndReturnsAlternatives(t *testing.T) {
	var gotBackend RephraseBackend
	calls := 0
	factory := func(b RephraseBackend) (LLMClient, error) {
		gotBackend = b
		return llmFunc(func(_ context.Context, _ Prompt) (string, error) {
			calls++
			return fmt.Sprintf("variant %d", calls), nil
		}), nil
	}
	svc := NewService(fakePB{}, nil, fakeLLM{out: "default"}, nil, "base", EscalationPolicy{})
	svc.SetRephraseFactory(factory)
	out, err := svc.Rephrase(context.Background(), RephraseRequest{
		Text: "x", Alternatives: 3,
		Override: &RephraseBackend{Provider: "anthropic", BaseURL: "u", Model: "m", APIKey: "k"},
	})
	require.NoError(t, err)
	require.Equal(t, "anthropic", gotBackend.Provider)
	require.Equal(t, "variant 1", out.Rephrased)
	require.Len(t, out.Alternatives, 2) // 3 total - 1 primary
}

func TestServiceCompleteHappyPath(t *testing.T) {
	st := &fakeStore{}
	svc := NewService(fakePB{}, nil, fakeLLM{out: " fox jumps over the lazy dog."}, st, "m", fastPolicy())
	got, err := svc.Complete(context.Background(), "The quick brown", SourceOpenCode, 0)
	require.NoError(t, err)
	require.Equal(t, "fox jumps over the lazy dog.", got)
	require.Equal(t, int64(0), st.count, "complete must NOT log to the store")
}

func TestServiceCompleteTemperature(t *testing.T) {
	// Completion must apply a non-zero sampling temperature so continuations
	// vary across inputs (correction/rephrase/tone stay greedy at 0). A positive
	// per-request value overrides the service default; otherwise the default is
	// used.
	st := &fakeStore{}
	var gotTemp float64
	llm := llmFunc(func(_ context.Context, p Prompt) (string, error) {
		gotTemp = p.Temperature
		return "x", nil
	})
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	svc.SetCompleteTemperature(0.4)

	// No per-request temperature → service default applies.
	_, err := svc.Complete(context.Background(), "Refactor the", SourceOpenCode, 0)
	require.NoError(t, err)
	require.InDelta(t, 0.4, gotTemp, 1e-9, "completion must use the configured default temperature")

	// Per-request temperature overrides the default.
	_, err = svc.Complete(context.Background(), "Refactor that", SourceOpenCode, 0.9)
	require.NoError(t, err)
	require.InDelta(t, 0.9, gotTemp, 1e-9, "per-request temperature must override the default")
}

func TestServiceCompleteCacheElidesSecondLLMCall(t *testing.T) {
	st := &fakeStore{}
	var calls int
	llm := llmFunc(func(_ context.Context, _ Prompt) (string, error) {
		calls++
		return " the auth module", nil
	})
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	svc.SetCompleteCache(8)

	// First call hits the LLM.
	got1, err := svc.Complete(context.Background(), "Fix the failing test in", SourceOpenCode, 0)
	require.NoError(t, err)
	require.Equal(t, "the auth module", got1)
	require.Equal(t, 1, calls)

	// Identical source+text → served from cache, NO second LLM call.
	got2, err := svc.Complete(context.Background(), "Fix the failing test in", SourceOpenCode, 0)
	require.NoError(t, err)
	require.Equal(t, "the auth module", got2)
	require.Equal(t, 1, calls, "cache must elide the second LLM call")

	// Different source for the same text → distinct key → fresh LLM call
	// (completion is scoped by client, so the cache must not bleed).
	_, err = svc.Complete(context.Background(), "Fix the failing test in", SourceBrowser, 0)
	require.NoError(t, err)
	require.Equal(t, 2, calls, "different source must miss the cache")
}

func TestServiceCompleteLLMError(t *testing.T) {
	st := &fakeStore{}
	svc := NewService(fakePB{}, nil, fakeLLM{err: errAlways}, st, "m", fastPolicy())
	_, err := svc.Complete(context.Background(), "x", SourceOpenCode, 0)
	require.Error(t, err)
	require.Equal(t, int64(0), st.count, "complete must NOT log on backend error")
}

func TestServiceCompleteNilLLM(t *testing.T) {
	st := &fakeStore{}
	svc := NewService(fakePB{}, nil, nil, st, "m", fastPolicy())
	_, err := svc.Complete(context.Background(), "x", SourceOpenCode, 0)
	require.Error(t, err)
	require.Contains(t, err.Error(), "llm")
}

// pickyPB is a chat-style PromptBuilder for the picky-mode tests. It differs
// from fakePB in two ways:
//   - Build returns a chat_instruct prompt (so the grammar path is reachable
//     through the LLM, not via the fast path which fakePB doesn't use either,
//     but the chat template is what the picky code branches on).
//   - BuildStyle returns a non-empty chat prompt so the style pass actually
//     runs. fakePB's BuildStyle is the GRMR-native no-op (empty User).
type pickyPB struct{}

func (pickyPB) Build(req Request) Prompt {
	return Prompt{User: req.Text, System: "grammar", Template: TemplateChatInstruct}
}

func (pickyPB) BuildRephrase(req RephraseRequest) Prompt {
	return Prompt{User: req.Text, System: "rephrase", Template: TemplateChatInstruct}
}

func (pickyPB) BuildStyle(req Request) Prompt {
	return Prompt{User: req.Text, System: "style", Template: TemplateChatInstruct}
}

// BuildWithSpellingHints for the picky fake: chat-style. The fake renders a
// minimal hint block (just the flagged token and candidate, quoted) so
// service tests can assert the LLM was handed the right hints. The full
// arbitration text + edge cases (cap, security) are exercised separately in
// prompt.Builder's own tests.
func (pickyPB) BuildWithSpellingHints(req Request, hints []Suggestion) Prompt {
	base := pickyPB{}.Build(req)
	if len(hints) == 0 {
		return base
	}
	var b strings.Builder
	b.WriteString(base.System)
	b.WriteString(" |hints|")
	for _, h := range hints {
		b.WriteByte(' ')
		b.WriteString(strconv.Quote(h.Replacement))
	}
	base.System = b.String()
	return base
}

// BuildTone for pickyPB: chat-style, non-empty User so the service path runs.
// Real-system-prompt coverage (vocabulary, tag list) lives in prompt.Builder's
// own tests; this stub just satisfies the interface.
func (pickyPB) BuildTone(req ToneRequest) Prompt {
	return Prompt{User: req.Text, System: "tone", Template: TemplateChatInstruct}
}

func (pickyPB) BuildComplete(text string, _ Source) Prompt {
	return Prompt{System: "continue", User: text, Template: TemplateChatInstruct}
}

// spikePB is a chat-style PromptBuilder for the GF_FAST_HINTS tests. It
// records every call to BuildWithSpellingHints and renders BOTH the flagged
// token and the candidate (quoted) into the chat system prompt, mirroring
// what the real prompt.Builder does. Tests assert (a) the LLM saw the
// flagged token, and (b) the call counter matches the expected wiring (flag
// off => 0 calls; flag on with no spelling edits => 1 call but byte-
// identical output to Build).
type spikePB struct {
	plainSystem string
	hintsCalls  int
	lastHints   []Suggestion
}

func (p *spikePB) Build(req Request) Prompt {
	return Prompt{User: req.Text, System: p.plainSystem, Template: TemplateChatInstruct}
}

func (p *spikePB) BuildRephrase(req RephraseRequest) Prompt {
	return Prompt{User: req.Text, System: "rephrase", Template: TemplateChatInstruct}
}

func (p *spikePB) BuildStyle(req Request) Prompt {
	return Prompt{User: req.Text, System: "style", Template: TemplateChatInstruct}
}

func (p *spikePB) BuildWithSpellingHints(req Request, hints []Suggestion) Prompt {
	p.hintsCalls++
	p.lastHints = hints
	if len(hints) == 0 {
		return p.Build(req)
	}
	var b strings.Builder
	b.WriteString(p.plainSystem)
	b.WriteString(" |hints|")
	for _, h := range hints {
		if h.Span.Validate(len(req.Text)) == nil && h.Span.End > h.Span.Start {
			b.WriteByte(' ')
			b.WriteString(strconv.Quote(req.Text[h.Span.Start:h.Span.End]))
			b.WriteString(" -> ")
			b.WriteString(strconv.Quote(h.Replacement))
		}
	}
	return Prompt{User: req.Text, System: b.String(), Template: TemplateChatInstruct}
}

// BuildTone for spikePB: chat-style, non-empty User. Mirrors pickyPB.
func (p *spikePB) BuildTone(req ToneRequest) Prompt {
	return Prompt{User: req.Text, System: "tone", Template: TemplateChatInstruct}
}

func (p *spikePB) BuildComplete(text string, _ Source) Prompt {
	return Prompt{System: "continue", User: text, Template: TemplateChatInstruct}
}

// scriptedLLM returns grammarOut on grammar-shaped calls (System contains
// "grammar") and styleOut on style-shaped calls (System contains "style").
// err is returned for any call. The grammar-vs-style dispatch lets a single
// fake cover both pipelines in one test while still asserting that each path
// hit the LLM with the right prompt.
type scriptedLLM struct {
	grammarOut string
	styleOut   string
	grammarErr error
	styleErr   error
	grammarN   int
	styleN     int
}

func (s *scriptedLLM) Complete(_ context.Context, p Prompt) (string, error) {
	switch {
	case contains(p.System, "style"):
		s.styleN++
		return s.styleOut, s.styleErr
	default:
		s.grammarN++
		return s.grammarOut, s.grammarErr
	}
}

func contains(haystack, needle string) bool {
	if needle == "" {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

// Picky=false is the default path. The style LLM call must NOT be made at
// all; only the grammar path runs. No category:"style" suggestion must
// appear in the output.
func TestCorrectPickyFalseNoStylePass(t *testing.T) {
	st := &fakeStore{}
	llm := &scriptedLLM{
		grammarOut: "I have a cat",   // change vs input -> diffToSuggestions will emit
		styleOut:   "I have a kitty", // would-be style change; must NOT be reached
	}
	svc := NewService(pickyPB{}, nil, llm, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.Equal(t, 1, llm.grammarN, "grammar LLM must be called once (LLM-only path)")
	require.Equal(t, 0, llm.styleN, "style LLM must NOT be called when picky=false")
	for _, s := range got.Suggestions {
		require.NotEqual(t, CategoryStyle, s.Category,
			"picky=false must not emit style-category suggestions")
	}
}

// Picky=true with a chat-style PB and a fake LLM that returns a restyled
// string on the style call: result contains category:"style" suggestions,
// grammar suggestions still present with empty category. Use two clearly
// non-overlapping edits so this test stays focused on the wiring (not the
// overlap-drop rule, which has its own test below).
func TestCorrectPickyAddsStyleSuggestions(t *testing.T) {
	st := &fakeStore{}
	// Original: "I has a cat"
	// Grammar returns: "I have a cat"  -> suggestion on "has"->"have"
	// Style returns:   "I has a kitty" -> suggestion on "cat"->"kitty"
	// Two non-overlapping spans, both must survive.
	llm := &scriptedLLM{
		grammarOut: "I have a cat",
		styleOut:   "I has a kitty",
	}
	svc := NewService(pickyPB{}, nil, llm, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat", Picky: true})
	require.NoError(t, err)
	require.Equal(t, 1, llm.grammarN, "grammar LLM called once")
	require.Equal(t, 1, llm.styleN, "style LLM called once when picky=true")
	hasStyle := false
	hasGrammar := false
	for _, s := range got.Suggestions {
		if s.Category == CategoryStyle {
			hasStyle = true
		} else {
			hasGrammar = true
		}
	}
	require.True(t, hasStyle, "picky=true must emit at least one style suggestion when style LLM produces edits")
	require.True(t, hasGrammar, "picky=true must preserve grammar suggestions")
}

// Grammar wins on overlap: a style edit that overlaps a grammar edit must be
// dropped. Grammar suggestion survives with empty category. Use inputs where
// the grammar diff and the style diff BOTH touch the same byte span so the
// overlap-drop rule is the only thing that can produce a style-empty result.
func TestCorrectPickyStyleOverlapDroppedForGrammar(t *testing.T) {
	st := &fakeStore{}
	// Original: "I has a cat" (byte span of "has" is [2,5))
	// Grammar returns: "I have a cat"  -> diff emits a Suggestion on [2,5) "has"->"have"
	// Style returns:   "I had a cat"   -> diff emits a Suggestion on [2,5) "has"->"had"
	// Both touch [2,5) — the style one must be dropped.
	llm := &scriptedLLM{
		grammarOut: "I have a cat",
		styleOut:   "I had a cat",
	}
	svc := NewService(pickyPB{}, nil, llm, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat", Picky: true})
	require.NoError(t, err)
	var grammarEdits []Suggestion
	var styleEdits []Suggestion
	for _, s := range got.Suggestions {
		if s.Category == CategoryStyle {
			styleEdits = append(styleEdits, s)
		} else {
			grammarEdits = append(grammarEdits, s)
		}
	}
	require.NotEmpty(t, grammarEdits, "grammar suggestion must survive")
	require.Empty(t, styleEdits, "style edit overlapping a grammar edit must be dropped")
}

// Style LLM error is best-effort: the request must still succeed with the
// grammar suggestions intact. The style pass is a layer ON TOP of grammar;
// it must never fail the request.
func TestCorrectPickyStyleLLMErrorIsBestEffort(t *testing.T) {
	st := &fakeStore{}
	llm := &scriptedLLM{
		grammarOut: "I have a cat",
		styleErr:   errAlways,
	}
	svc := NewService(pickyPB{}, nil, llm, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat", Picky: true})
	require.NoError(t, err, "style LLM error must not surface to the caller")
	require.NotEmpty(t, got.Suggestions, "grammar suggestions must survive style LLM error")
	for _, s := range got.Suggestions {
		require.NotEqual(t, CategoryStyle, s.Category,
			"no style-category suggestions when style LLM errored")
	}
}

// GRMR-native (style pass returns empty User) must short-circuit: no extra
// LLM call, no style-category suggestions. Picky=true is harmless on
// GRMR-native; it's a chat-model feature.
func TestCorrectPickyGRMRNativeSkips(t *testing.T) {
	st := &fakeStore{}
	llm := &scriptedLLM{
		grammarOut: "I have a cat",
		styleOut:   "I has a kitty", // would-be style change; must NOT be reached
	}
	// fakePB.BuildStyle returns empty User (GRMR-native no-op).
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat", Picky: true})
	require.NoError(t, err)
	require.Equal(t, 1, llm.grammarN, "grammar LLM called once")
	require.Equal(t, 0, llm.styleN, "style LLM must NOT be called when BuildStyle is the GRMR-native no-op")
	for _, s := range got.Suggestions {
		require.NotEqual(t, CategoryStyle, s.Category,
			"GRMR-native picky must not emit style-category suggestions")
	}
}

// Default (picky absent) is the most important contract: the request must
// hit the LLM zero extra times (no style pass) and grammar suggestions must
// carry no category field (omitempty drops "").
func TestCorrectDefaultPickyEmitsNoCategoryAndNoExtraLLMCall(t *testing.T) {
	st := &fakeStore{}
	llm := &scriptedLLM{grammarOut: "I have a cat"}
	svc := NewService(pickyPB{}, nil, llm, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.Equal(t, 1, llm.grammarN)
	require.Equal(t, 0, llm.styleN, "default path must not run the style pass")
	for _, s := range got.Suggestions {
		require.Equal(t, CategoryGrammar, s.Category,
			"grammar suggestions on the default path must have empty category")
	}
}

// LLM-only path with picky=true: finalize must run ONCE on the combined
// grammar+style set, NOT first on grammar-only and then again on
// grammar+style. The bug shape was:
//
//	llmOnly -> finalize(logs grammar-only applied text, tags grammar IDs)
//	Correct -> appendStyleSuggestions (runs after finalize)
//	         -> returns result with style suggestions, ID==0, never logged
//
// The contract this test locks:
//   - The logged Event.Suggestion == text with BOTH grammar AND style edits
//     applied (the user's acceptance of a style suggestion will replay the
//     combined rewrite, not a grammar-only one).
//   - Every returned suggestion (grammar and style) has the SAME non-zero
//     logged id, so /signal can reference both kinds.
//   - Style suggestions are present in the result with category="style".
//   - Score is computed on the combined set (covered indirectly: Score is
//     derived from the suggestions slice that finalize tags).
func TestCorrectPickyLLMOnlyFinalizesCombined(t *testing.T) {
	st := &fakeStore{}
	// Grammar: "I has a cat" -> "I have a cat"   (one suggestion on "has"->"have")
	// Style:   "I has a cat" -> "I has a kitty"  (one suggestion on "cat"->"kitty")
	// Combined applied text: "I have a kitty" (apply grammar first, then style
	// is on a non-overlapping span so the result is the AND of both).
	llm := &scriptedLLM{
		grammarOut: "I have a cat",
		styleOut:   "I has a kitty",
	}
	svc := NewService(pickyPB{}, nil, llm, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat", Picky: true})
	require.NoError(t, err)
	require.Equal(t, 1, llm.grammarN, "grammar LLM called once")
	require.Equal(t, 1, llm.styleN, "style LLM called once when picky=true")
	// 1) Logged event: combined applied text.
	require.Equal(t, "I have a kitty", st.lastEvent.Suggestion,
		"logged Suggestion must be the COMBINED grammar+style applied text, not grammar-only")
	require.Equal(t, "I has a cat", st.lastEvent.Original)
	require.Equal(t, int64(1), st.count, "finalize must run exactly once for a picky+edits result")
	// 2) Every returned suggestion (grammar and style) carries the logged id.
	require.NotEmpty(t, got.Suggestions)
	nonZeroIDs := 0
	hasStyle := false
	for _, s := range got.Suggestions {
		if s.ID != 0 {
			nonZeroIDs++
		}
		if s.Category == CategoryStyle {
			hasStyle = true
		}
	}
	require.Equal(t, len(got.Suggestions), nonZeroIDs,
		"every returned suggestion (grammar and style) must carry the logged id so /signal can reference style suggestions")
	require.True(t, hasStyle, "style suggestion must be present in the result")
}

// Style-only picky case on the llmOnly path: grammar LLM returns the
// input unchanged (no grammar diff), style LLM returns a rewrite (one
// style suggestion). The request must still log a non-empty event and
// tag the style suggestion with the logged id. The old (buggy) flow
// would skip finalize entirely on the style pass, leaving the suggestion
// with ID==0 and logging nothing.
func TestCorrectPickyLLMOnlyStyleOnlyLogsAndTags(t *testing.T) {
	st := &fakeStore{}
	llm := &scriptedLLM{
		grammarOut: "I has a cat", // unchanged from input -> 0 grammar diffs
		styleOut:   "I has a kitty",
	}
	svc := NewService(pickyPB{}, nil, llm, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat", Picky: true})
	require.NoError(t, err)
	// Style suggestion must be present.
	var styleCount int
	for _, s := range got.Suggestions {
		if s.Category == CategoryStyle {
			styleCount++
			require.NotEqual(t, int64(0), s.ID,
				"style suggestion on the llmOnly path must be tagged with the logged id")
		}
	}
	require.Equal(t, 1, styleCount, "one style suggestion expected")
	// The store must have logged the style-only correction.
	require.Equal(t, int64(1), st.count,
		"style-only picky result on the llmOnly path must still be logged (finalize runs on the combined set)")
	require.Equal(t, "I has a kitty", st.lastEvent.Suggestion,
		"logged Suggestion must reflect the style rewrite")
}

// applyAll assumes suggestions are sorted by ascending Span.Start so that
// later-to-earlier application keeps earlier byte offsets valid. The picky
// style pass appends style edits after grammar edits; if a style edit's
// span is EARLIER than a grammar edit's span, the combined slice is out
// of order and applyAll corrupts the logged Event.Suggestion.
//
// Concrete shape (length-changing on both edits to amplify the bug):
//
//	original:        "the cat runned"  (14 bytes)
//	grammar LLM:     "the cat run"     -> Suggestion [10,14) "ned"->""  (deletion at a LATER span)
//	style LLM:       "a cat runned"    -> Suggestion [0,3)  "the"->"a" (replacement at an EARLIER span)
//
// Combined (BUG order, grammar first then style):
//
//	[{Span:[10,14) Rpl:"" Cat:"" Model:LLM},
//	 {Span:[0,3)  Rpl:"a" Cat:"style" Model:LLM}]
//
// applyAll applies last-to-first. With the bug:
//   - i=1: style [0,3) "the"->"a"  on "the cat runned"  -> "a cat runned" (12 bytes)
//   - i=0: grammar [10,14) "ned"->"" on "a cat runned"   -> Span.Validate(12) errors -> returns "a cat runned" UNCHANGED (the in-bounds span is no longer "ned" — bytes shifted; AND the original end 14 is now out of bounds of the 12-byte string)
//
// Expected combined text: "a cat run" (delete the trailing "ned" AND replace "the" with "a"). The fix (sort combined by Span.Start ascending) produces the right text.
//
// This test asserts the logged Event.Suggestion and the returned
// result.Suggestions are in ascending Span.Start order.
func TestCorrectPickyStyleBeforeGrammarLogsCorrectCombinedText(t *testing.T) {
	st := &fakeStore{}
	llm := &scriptedLLM{
		grammarOut: "the cat run",  // deletes trailing "ned" at [10,14)
		styleOut:   "a cat runned", // replaces "the" with "a" at [0,3)
	}
	svc := NewService(pickyPB{}, nil, llm, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "the cat runned", Picky: true})
	require.NoError(t, err)
	// Logged combined text must reflect BOTH edits applied in the right order.
	require.Equal(t, "a cat run", st.lastEvent.Suggestion,
		"logged Suggestion must be the correct combined rewrite (style+grammar), not the corrupted out-of-order applyAll result")
	// Returned suggestions must be in ascending Span.Start order (so clients
	// and any downstream consumer that applies them last-to-first get the
	// right result).
	for i := 1; i < len(got.Suggestions); i++ {
		require.Less(t, got.Suggestions[i-1].Span.Start, got.Suggestions[i].Span.Start,
			"returned suggestions must be sorted by ascending Span.Start")
	}
	// And the in-hand applyAll result must match the logged text.
	require.Equal(t, "a cat run", applyAll("the cat runned", got.Suggestions),
		"applying the returned suggestions to the original must yield the logged text")
}

// ---- Truncation guard (verified data-loss bug, 2026-06-10) ----
// A truncated LLM response (backend hit max_tokens, or any failure mode that
// returns a fraction of the input) must NEVER reach diffToSuggestions: the
// diff converts the missing tail into mass-deletion suggestions that a
// client's Apply All would actually apply. The service treats a suspiciously
// short LLM output (less than half the original, on a non-trivial input) as
// an LLM failure.

func TestServiceEscalationDiscardsSuspiciouslyShortLLMOutput(t *testing.T) {
	st := &fakeStore{}
	// Single long sentence (no internal period) so the per-segment guard
	// exercises correctOnce exactly once and the truncation check applies
	// to the whole-text call. A 10-sentence variant would segment per
	// sentence and each per-segment LLM call sees a 46-char input, below
	// the 200-byte truncation guard threshold.
	long := strings.Repeat("The quick brown fox jumps over the lazy dog and the lazy cat and the lazy mouse and the lazy horse ", 4)
	require.GreaterOrEqual(t, len(long), minOriginalLenForTruncationGuard, "fixture must clear the truncation-guard threshold")
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{0, 3}, Replacement: "A", Model: ModelGECToR, Confidence: 0.3}},
	}
	// Low confidence forces escalation; the LLM "responds" with a truncated
	// fragment. The fast-path suggestion must be served, not the LLM diff.
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{out: "The quick brown fox."}, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: long})
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1)
	require.Equal(t, ModelGECToR, got.Suggestions[0].Model,
		"truncated LLM output must be discarded; fast-path result served")
}

func TestServiceLLMOnlyErrorsOnSuspiciouslyShortOutput(t *testing.T) {
	long := strings.Repeat("The quick brown fox jumps over the lazy dog and the lazy cat and the lazy mouse and the lazy horse ", 4)
	require.GreaterOrEqual(t, len(long), minOriginalLenForTruncationGuard, "fixture must clear the truncation-guard threshold")
	svc := NewService(fakePB{}, nil, fakeLLM{out: "The quick."}, &fakeStore{}, "m", fastPolicy())
	_, err := svc.Correct(context.Background(), Request{Text: long})
	require.Error(t, err, "LLM-only path must surface a truncated output as an error, not as mass deletions")
}

func TestCorrectPickyStyleDiscardsSuspiciouslyShortOutput(t *testing.T) {
	st := &fakeStore{}
	// Single long sentence (no internal period) so the truncation check
	// applies to the whole-text style call.
	long := strings.Repeat("The quick brown fox jumps over the lazy dog and the lazy cat and the lazy mouse and the lazy horse ", 4)
	require.GreaterOrEqual(t, len(long), minOriginalLenForTruncationGuard, "fixture must clear the truncation-guard threshold")
	llm := &scriptedLLM{grammarOut: long, styleOut: "Short."}
	svc := NewService(pickyPB{}, nil, llm, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: long, Picky: true})
	require.NoError(t, err)
	for _, s := range got.Suggestions {
		require.NotEqual(t, CategoryStyle, s.Category,
			"truncated style output must be discarded, not diffed into style deletions")
	}
}

type countingLLM struct {
	calls int
}

func (c *countingLLM) Complete(_ context.Context, p Prompt) (string, error) {
	c.calls++
	// Echo the input back "corrected": fakePB puts the raw text in p.User.
	return p.User, nil
}

func TestSentencePipelineCachesUnchangedSentences(t *testing.T) {
	st := &fakeStore{}
	llm := &countingLLM{}
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	svc.SetSentenceCache(64)
	text := "This is the first sentence. This is the second sentence."
	_, err := svc.Correct(context.Background(), Request{Text: text})
	require.NoError(t, err)
	firstCalls := llm.calls
	require.Equal(t, 2, firstCalls, "cold: one LLM call per sentence")
	_, err = svc.Correct(context.Background(), Request{Text: text})
	require.NoError(t, err)
	require.Equal(t, firstCalls, llm.calls, "warm: zero additional LLM calls")
}

func TestSentencePipelineOnlyChangedSentenceMisses(t *testing.T) {
	st := &fakeStore{}
	llm := &countingLLM{}
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	svc.SetSentenceCache(64)
	_, err := svc.Correct(context.Background(), Request{Text: "Stable first sentence here. Old second sentence here."})
	require.NoError(t, err)
	before := llm.calls
	_, err = svc.Correct(context.Background(), Request{Text: "Stable first sentence here. New second sentence here."})
	require.NoError(t, err)
	require.Equal(t, before+1, llm.calls, "editing one sentence must re-check ONLY that sentence")
}

func TestSentencePipelineShiftsSpansToTextOffsets(t *testing.T) {
	st := &fakeStore{}
	// LLM "fixes" only the second sentence: replaces "cats." with "a kitty."
	// (the resulting character-level diff from sergi/go-diff spans a whole
	// word, so the assertion below can verify the shifted span against the
	// original text unambiguously — see deviation note in the plan report).
	svc := NewService(fakePB{}, nil, llmFunc(func(_ context.Context, p Prompt) (string, error) {
		return strings.ReplaceAll(p.User, "cats.", "a kitty."), nil
	}), st, "m", fastPolicy())
	svc.SetSentenceCache(64)
	text := "The first sentence is fine. He has cats."
	got, err := svc.Correct(context.Background(), Request{Text: text})
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1)
	sp := got.Suggestions[0].Span
	require.Equal(t, "cats", text[sp.Start:sp.End], "span must be shifted to WHOLE-TEXT offsets")
}

func TestSentencePipelineDisabledWithoutCache(t *testing.T) {
	st := &fakeStore{}
	llm := &countingLLM{}
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	// No SetSentenceCache: cache stays nil. Multi-segment input STILL
	// goes through the per-segment path (the guard is now len(segs)<2,
	// not the cache); the per-segment loop no-ops the cache (nil
	// receiver), so each segment is recomputed. 2 sentences -> 2 LLM
	// calls. Single-segment input (len(segs)<2) takes the legacy
	// whole-text path; see TestSentencePipelineSingleSegmentCacheOff.
	_, err := svc.Correct(context.Background(), Request{Text: "One sentence. Two sentences."})
	require.NoError(t, err)
	require.Equal(t, 2, llm.calls, "multi-segment input always goes through per-segment path, cache or not")
}

func TestSentencePipelineSingleSegmentCacheOffTakesWholeTextPath(t *testing.T) {
	// Single-segment input (no sentence terminator) takes the legacy
	// whole-text path regardless of cache state. The guard is now
	// `len(segs) < 2`, not the cache, so a single-segment input with the
	// cache disabled still hits correctOnce exactly once. This pins the
	// "do NOT change single-segment behavior" invariant.
	st := &fakeStore{}
	llm := &countingLLM{}
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	// No SetSentenceCache.
	_, err := svc.Correct(context.Background(), Request{Text: "Just one fragment with no terminator"})
	require.NoError(t, err)
	require.Equal(t, 1, llm.calls, "single-segment -> whole-text, cache or not")
}

func TestFinalizeTagsEachSuggestionWithItsOwnEditID(t *testing.T) {
	st := &fakeStore{}
	// Use a fast corrector with EXPLICIT spans (the LLM-diff path emits
	// char-level minimal edits, so word-level Original assertions would be
	// brittle there). High confidence + fastPolicy (EscalateOnFastEdit off)
	// means the LLM is never called.
	fc := fakeCorrector{name: string(ModelGECToR), sugs: []Suggestion{
		{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Confidence: 0.95},
		{Span: Span{6, 9}, Replacement: "the", Model: ModelGECToR, Confidence: 0.95},
	}}
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{err: errAlways}, st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(), Request{Text: "I has teh cat", Source: SourceBrowser}) //nolint:misspell // intentional fixture
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 2)
	require.Equal(t, int64(101), got.Suggestions[0].ID)
	require.Equal(t, int64(102), got.Suggestions[1].ID, "each suggestion must carry its OWN edit id")
	require.Len(t, st.lastEvent.Edits, 2)
	require.Equal(t, "has", st.lastEvent.Edits[0].Original)
	require.Equal(t, "have", st.lastEvent.Edits[0].Replacement)
	require.Equal(t, "teh", st.lastEvent.Edits[1].Original) //nolint:misspell // intentional fixture
}

// fakeAllowlist is a set-backed WordAllowlist for tests. Membership is
// case-insensitive: the test fixture stores the lowercased form so the
// service's lowercase lookup hits.
type fakeAllowlist struct{ words map[string]bool }

func (f fakeAllowlist) Contains(w string) bool { return f.words[strings.ToLower(w)] }

// A single-word edit whose span text is in the user dictionary must be
// dropped. The allowlist guards against an LLM re-flagging a word the user
// has explicitly added (the LLM did not see the dictionary, so a
// confident-wrong fast edit could otherwise be re-emitted on escalation).
// Fixture: input string is two words; bytes [0,10) cover the allowlisted
// word and bytes [11,14) cover a misspelled 3-letter word whose fix is
// "the". Only the fix for the misspelled word survives.
func TestCorrectSuppressesAllowlistedSingleWordEdits(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{name: string(ModelGECToR), sugs: []Suggestion{
		{Span: Span{0, 10}, Replacement: "Kubernetes", Model: ModelGECToR, Confidence: 0.95},
		{Span: Span{11, 14}, Replacement: "the", Model: ModelGECToR, Confidence: 0.95},
	}}
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{err: errAlways}, st, "m", fastPolicy())
	svc.SetWordAllowlist(fakeAllowlist{words: map[string]bool{"kubernetes": true}})
	got, err := svc.Correct(context.Background(), Request{Text: "kubernetes teh"}) //nolint:misspell // intentional fixture
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1, "the allowlisted word's edit is dropped")
	require.Equal(t, "the", got.Suggestions[0].Replacement)
}

// A multi-word edit containing a NON-allowlisted token is kept — suppression
// requires EVERY token in the span to be in the user dictionary. Fixture:
// "kuberntes podz" — bytes [0,14) = the whole string. The tokens are the
// misspelled "kuberntes" (not in the dictionary; only "kubernetes" is) and
// "podz" (not in the dictionary), so the edit is a real correction and
// survives.
func TestCorrectAllowlistDoesNotDropMultiWordEdit(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{name: string(ModelGECToR), sugs: []Suggestion{
		{Span: Span{0, 14}, Replacement: "Kubernetes pods", Model: ModelGECToR, Confidence: 0.95},
	}}
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{err: errAlways}, st, "m", fastPolicy())
	svc.SetWordAllowlist(fakeAllowlist{words: map[string]bool{"kubernetes": true}})
	got, err := svc.Correct(context.Background(), Request{Text: "kuberntes podz"})
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1, "a multi-word edit containing the word is NOT dropped")
}

// A multi-word edit whose span tokens are ALL in the user dictionary is
// dropped. The LLM can merge two adjacent unknown words into one edit
// (verified live); after the user adds both words, that merged edit must not
// be re-emitted — Harper stops flagging each word, and this guard stops the
// LLM path from re-flagging the pair.
func TestCorrectSuppressesAllowlistedMultiWordEdit(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{name: string(ModelGECToR), sugs: []Suggestion{
		{Span: Span{0, 9}, Replacement: "Glory Six", Model: ModelGECToR, Confidence: 0.95},
		{Span: Span{10, 13}, Replacement: "the", Model: ModelGECToR, Confidence: 0.95},
	}}
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{err: errAlways}, st, "m", fastPolicy())
	svc.SetWordAllowlist(fakeAllowlist{words: map[string]bool{"glorp": true, "zix": true}})
	got, err := svc.Correct(context.Background(), Request{Text: "Glorp Zix teh"}) //nolint:misspell // intentional fixture
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1, "the all-allowlisted multi-word edit is dropped")
	require.Equal(t, "the", got.Suggestions[0].Replacement)
}

// The diff TRIMS the edit's common prefix/suffix, so an LLM rewrite of two
// dictionary words sharing a leading/trailing letter has a span covering only
// word FRAGMENTS (verified live: span tokens like "lorp Zi" while the
// dictionary holds the full words). Suppression must expand the span to the
// surrounding whitespace word boundaries BEFORE tokenizing, so the fragments
// resolve to the real words and the edit is dropped.
func TestCorrectSuppressesTrimmedSpanInsideAllowlistedWords(t *testing.T) {
	st := &fakeStore{}
	// Span {1,8} over the fixture text is "lorp Zi" — the trimmed fragment of
	// the two dictionary words (shared first/last letters with the rewrite).
	fc := fakeCorrector{name: string(ModelGECToR), sugs: []Suggestion{
		{Span: Span{1, 8}, Replacement: "lory Si", Model: ModelGECToR, Confidence: 0.95},
		{Span: Span{10, 13}, Replacement: "the", Model: ModelGECToR, Confidence: 0.95},
	}}
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{err: errAlways}, st, "m", fastPolicy())
	svc.SetWordAllowlist(fakeAllowlist{words: map[string]bool{"glorp": true, "zix": true}})
	got, err := svc.Correct(context.Background(), Request{Text: "Glorp Zix teh"}) //nolint:misspell // intentional fixture
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1, "the fragment-span edit inside dictionary words is dropped")
	require.Equal(t, "the", got.Suggestions[0].Replacement)
}

// Expansion must not OVER-suppress: an edit whose expanded words include a
// non-dictionary token (e.g. punctuation glued to a dictionary word, or a
// genuinely misspelled neighbour) is kept.
func TestCorrectAllowlistExpansionKeepsNonDictionaryTokens(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{name: string(ModelGECToR), sugs: []Suggestion{
		// Span {9,10} is the "." — expands to "Zix." which is NOT the
		// dictionary word "Zix"; a punctuation fix next to a dictionary
		// word must survive.
		{Span: Span{9, 10}, Replacement: "!", Model: ModelGECToR, Confidence: 0.95},
	}}
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{err: errAlways}, st, "m", fastPolicy())
	svc.SetWordAllowlist(fakeAllowlist{words: map[string]bool{"glorp": true, "zix": true}})
	got, err := svc.Correct(context.Background(), Request{Text: "Glorp Zix."})
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1, "a punctuation edit glued to a dictionary word is kept")
}

// ---- over-edit repair integration ----

func TestCorrectLLMOnlyAppliesOverEditRules(t *testing.T) {
	// LLM-only path: the LLM flips correct proximity agreement; with the
	// default over-edit rules set, the flip is repaired BEFORE the diff, so
	// no suggestion is emitted at all.
	st := &fakeStore{}
	svc := NewService(fakePB{}, nil,
		fakeLLM{out: "Neither the manager nor the employees was aware of the change."},
		st, "m", fastPolicy())
	svc.SetOverEditRules(DefaultOverEditRules())
	got, err := svc.Correct(context.Background(),
		Request{Text: "Neither the manager nor the employees were aware of the change."})
	require.NoError(t, err)
	require.Empty(t, got.Suggestions, "over-edit reverted; nothing left to suggest")
	require.Equal(t, int64(0), st.count, "no suggestions -> nothing logged")
}

func TestCorrectEscalationAppliesOverEditRules(t *testing.T) {
	// Escalation path: a low-confidence fast edit forces escalation; the LLM
	// output contains a wanted capitalization fused with an unwanted comma
	// restructure (golden case 91's shape). The repaired diff keeps the caps
	// and drops the restructure.
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{0, 2}, Replacement: "We", Model: ModelGECToR, Confidence: 0.3}},
	}
	svc := NewService(fakePB{}, []Corrector{fc},
		fakeLLM{out: "We flew to Paris, France, last April."},
		st, "m", fastPolicy())
	svc.SetOverEditRules(DefaultOverEditRules())
	got, err := svc.Correct(context.Background(),
		Request{Text: "we flew to paris in france last april."})
	require.NoError(t, err)
	require.Equal(t, "We flew to Paris in France last April.", st.lastEvent.Suggestion,
		"caps kept, comma restructure reverted")
	require.NotEmpty(t, got.Suggestions)
}

func TestCorrectWithoutOverEditRulesIsUnchanged(t *testing.T) {
	// No rules set (legacy behaviour): the over-edited output is served as-is.
	st := &fakeStore{}
	svc := NewService(fakePB{}, nil,
		fakeLLM{out: "Neither the manager nor the employees was aware of the change."},
		st, "m", fastPolicy())
	got, err := svc.Correct(context.Background(),
		Request{Text: "Neither the manager nor the employees were aware of the change."})
	require.NoError(t, err)
	require.NotEmpty(t, got.Suggestions, "nil rules must keep byte-identical legacy behaviour")
}

// ---- merge-not-replace escalation (GF_MERGE_FAST_EDITS spike) ----

// mergeTestService builds a service with one low-confidence fast corrector
// (forces escalation) whose suggestions are pre-baked, an LLM with fixed
// output, and the given merge mode.
func mergeTestService(st *fakeStore, fastSugs []Suggestion, llmOut, mode string) *Service {
	fc := fakeCorrector{name: string(ModelGECToR), sugs: fastSugs}
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{out: llmOut}, st, "m", fastPolicy())
	svc.SetMergeFastEditsMode(mode)
	return svc
}

func TestCorrectMergeModeOffReplacesFastEdits(t *testing.T) {
	// Default (""): legacy replace semantics — the non-overlapping fast edit
	// is NOT in the result.
	st := &fakeStore{}
	fast := []Suggestion{
		{Span: Span{0, 1}, Replacement: "X", Model: ModelGECToR, Confidence: 0.3},
		{Span: Span{12, 15}, Replacement: "cats", Model: ModelGECToR, Confidence: 0.3},
	}
	svc := mergeTestService(st, fast, "I have a big cat", "")
	got, err := svc.Correct(context.Background(), Request{Text: "I has a big cat"})
	require.NoError(t, err)
	for _, s := range got.Suggestions {
		require.Equal(t, ModelLLM, s.Model, "replace semantics: only LLM edits")
	}
}

func TestCorrectMergeGECToRAddsNonOverlappingEdit(t *testing.T) {
	// gector mode: the fast edit on a span the LLM left alone joins the
	// result; the overlapping one is dropped (LLM authoritative).
	st := &fakeStore{}
	fast := []Suggestion{
		{Span: Span{2, 5}, Replacement: "had", Model: ModelGECToR, Confidence: 0.3},    // overlaps LLM has->have
		{Span: Span{12, 15}, Replacement: "cats", Model: ModelGECToR, Confidence: 0.3}, // LLM silent here
	}
	svc := mergeTestService(st, fast, "I have a big cat", "gector")
	got, err := svc.Correct(context.Background(), Request{Text: "I has a big cat"})
	require.NoError(t, err)
	var gectorEdits []Suggestion
	for _, s := range got.Suggestions {
		if s.Model == ModelGECToR {
			gectorEdits = append(gectorEdits, s)
		}
	}
	require.Len(t, gectorEdits, 1, "exactly the non-overlapping fast edit merges")
	require.Equal(t, Span{12, 15}, gectorEdits[0].Span)
	require.Equal(t, "I have a big cats", st.lastEvent.Suggestion, "combined application")
}

func TestCorrectMergeGECToRExcludesHarperEdits(t *testing.T) {
	// gector mode merges ONLY GECToR edits; a Harper edit stays out even
	// when non-overlapping.
	st := &fakeStore{}
	fc := fakeCorrector{name: string(ModelHarper), sugs: []Suggestion{
		{Span: Span{12, 15}, Replacement: "kat", Model: ModelHarper, Category: CategorySpelling, Confidence: 0.3},
	}}
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{out: "I have a big cat"}, st, "m", fastPolicy())
	svc.SetMergeFastEditsMode("gector")
	got, err := svc.Correct(context.Background(), Request{Text: "I has a big cat"})
	require.NoError(t, err)
	for _, s := range got.Suggestions {
		require.NotEqual(t, ModelHarper, s.Model, "harper edits excluded in gector mode")
	}
}

func TestCorrectMergeAllIncludesHarperEdits(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{name: string(ModelHarper), sugs: []Suggestion{
		{Span: Span{12, 15}, Replacement: "hat", Model: ModelHarper, Category: CategorySpelling, Confidence: 0.3},
	}}
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{out: "I have a big cat"}, st, "m", fastPolicy())
	svc.SetMergeFastEditsMode("all")
	got, err := svc.Correct(context.Background(), Request{Text: "I has a big cat"})
	require.NoError(t, err)
	models := map[Model]bool{}
	for _, s := range got.Suggestions {
		models[s.Model] = true
	}
	require.True(t, models[ModelHarper], "all mode merges harper edits too")
}

func TestCorrectMergeDropsTouchingInsertion(t *testing.T) {
	// A zero-width fast insertion at the boundary of an LLM edit must be
	// dropped (closed-interval conflict) — merging both would double-insert.
	st := &fakeStore{}
	fast := []Suggestion{
		{Span: Span{15, 15}, Replacement: "s", Model: ModelGECToR, Confidence: 0.3},
	}
	svc := mergeTestService(st, fast, "I has a big cats", "gector")
	// LLM already appends the trailing "s" via its own edit ending at 15.
	got, err := svc.Correct(context.Background(), Request{Text: "I has a big cat"})
	require.NoError(t, err)
	require.Equal(t, "I has a big cats", st.lastEvent.Suggestion,
		"no double-applied insertion")
	for _, s := range got.Suggestions {
		require.Equal(t, ModelLLM, s.Model, "touching fast insertion dropped")
	}
}

// ---- staged correction (SSE fast-path preview) ----

func TestCorrectStagedEmitsAtLeastOneFastPreviewThenFinal(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Confidence: 0.3}},
	}
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{out: "I have a cat"}, st, "m", fastPolicy())
	var fastFrames []Correction
	got, err := svc.CorrectStaged(context.Background(), Request{Text: "I has a cat"}, func(c Correction) {
		fastFrames = append(fastFrames, c)
		require.Equal(t, int64(0), st.count, "fast preview must be emitted BEFORE any logging")
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(fastFrames), 1, "onFast called at least once")
	require.NotEmpty(t, fastFrames[0].Suggestions)
	for _, s := range fastFrames[0].Suggestions {
		require.Zero(t, s.ID, "fast preview suggestions are unlogged -> no IDs")
		require.Equal(t, ModelGECToR, s.Model)
	}
	require.NotEmpty(t, got.Suggestions, "final result comes from the normal pipeline")
	require.Equal(t, int64(1), st.count, "final is logged exactly once")
}

func TestCorrectStagedEmitsIncrementalFastFrames(t *testing.T) {
	st := &fakeStore{}
	// Two independent fast correctors → expect 2 fast frames before final.
	fc1 := fakeCorrector{name: "harper", sugs: []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: "harper"}}}
	fc2 := fakeCorrector{name: "gector", sugs: []Suggestion{{Span: Span{6, 8}, Replacement: "a", Model: "gector"}}}
	svc := NewService(fakePB{}, []Corrector{fc1, fc2}, fakeLLM{out: "I have a cat"}, st, "m", fastPolicy())
	var fastFrames []Correction
	_, err := svc.CorrectStaged(context.Background(), Request{Text: "I has a cat"}, func(c Correction) {
		fastFrames = append(fastFrames, c)
		// Fast frames must be emitted BEFORE any logging (Correct hasn't run yet).
		require.Equal(t, int64(0), st.count, "fast preview must be emitted before any logging")
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(fastFrames), 2, "multi-frame stream must emit at least 2 fast frames")
	// All fast frames: no IDs (unlogged previews).
	for _, f := range fastFrames {
		for _, s := range f.Suggestions {
			require.Zero(t, s.ID, "fast preview suggestions must have no IDs")
		}
	}
	// First frame has only harper's suggestion; second frame accumulates both.
	require.Len(t, fastFrames[0].Suggestions, 1, "first frame: only harper's suggestion")
	require.Equal(t, Model("harper"), fastFrames[0].Suggestions[0].Model)
	require.GreaterOrEqual(t, len(fastFrames[1].Suggestions), 1, "second frame: accumulated suggestions")
	// After CorrectStaged returns, the final Correct call has logged exactly once.
	require.Equal(t, int64(1), st.count, "final is logged exactly once")
}

func TestCorrectStagedEmptyFastStillCalled(t *testing.T) {
	st := &fakeStore{}
	// LLM-only mode (no fast correctors): preview is empty but still emitted.
	svc := NewService(fakePB{}, nil, fakeLLM{out: "all good"}, st, "m", fastPolicy())
	called := 0
	_, err := svc.CorrectStaged(context.Background(), Request{Text: "all good"}, func(c Correction) {
		called++
		require.Empty(t, c.Suggestions)
		require.Equal(t, 100, c.Score)
	})
	require.NoError(t, err)
	require.Equal(t, 1, called, "empty preview still emitted so the client can clear state")
}

func TestCorrectStagedDropsAllowlistedFastEdits(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelHarper),
		sugs: []Suggestion{{
			Span: Span{0, 5}, Replacement: "Glory",
			Model: ModelHarper, Category: CategorySpelling, Confidence: 0.95,
		}},
	}
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{out: "Glorp likes tea"}, st, "m", fastPolicy())
	svc.SetWordAllowlist(fakeAllowlist{words: map[string]bool{"glorp": true}})
	var fast Correction
	_, err := svc.CorrectStaged(context.Background(), Request{Text: "Glorp likes tea"},
		func(c Correction) { fast = c })
	require.NoError(t, err)
	require.Empty(t, fast.Suggestions, "dictionary words must not flash preview underlines")
}

func TestCorrectStagedNilCallbackBehavesLikeCorrect(t *testing.T) {
	st := &fakeStore{}
	svc := NewService(fakePB{}, nil, fakeLLM{out: "I have a cat"}, st, "m", fastPolicy())
	got, err := svc.CorrectStaged(context.Background(), Request{Text: "I has a cat"}, nil)
	require.NoError(t, err)
	require.NotEmpty(t, got.Suggestions)
}

// ---- GF_FAST_HINTS spike (Harper spelling candidates -> LLM system prompt) ----
//
// When the LLM is called, the escalation branch MUST pass Harper's SPELLING
// candidates to the LLM as arbitration hints. Default OFF; opt in with
// GF_FAST_HINTS=true. Hints are deterministic per sentence (depends only on
// the fast-path output of the original text) so the sentence-cache key
// (which hashes only Build(req).System, not the rendered-with-hints prompt)
// stays consistent and a hot reload does not invalidate the cache.

// (a) flag ON + low-confidence Harper spelling edit forces escalation -> the
// LLM receives a system prompt containing the flagged token. Use a chat-style
// spikePB that records and renders hints so we can assert on capturingLLM.
func TestFastHintsFlagOnThreadsSpellingEditsToLLM(t *testing.T) {
	st := &fakeStore{}
	// Harper spelling edit on "sdasd" with conf 0.3 (below 0.7 floor) ->
	// escalates. With the flag ON, the LLM should see "sdasd" as a hint.
	fc := fakeCorrector{
		name: string(ModelHarper),
		sugs: []Suggestion{
			{Span: Span{0, 5}, Replacement: "sad", Model: ModelHarper, Category: CategorySpelling, Confidence: 0.3},
		},
	}
	pb := &spikePB{plainSystem: "base-grammar-system"}
	llm := &capturingLLM{out: "I went to the store"}
	svc := NewService(pb, []Corrector{fc}, llm, st, "m", fastPolicy())
	svc.SetFastHintsEnabled(true)
	_, err := svc.Correct(context.Background(), Request{Text: "sdasd went to the store"})
	require.NoError(t, err)
	require.Equal(t, 1, pb.hintsCalls,
		"BuildWithSpellingHints must be called exactly once on escalation when flag is ON")
	// The LLM's System prompt must contain the flagged token (proving the
	// hint reached the escalation prompt).
	require.Contains(t, llm.gotPrompt.System, "sdasd",
		"escalation prompt must contain the flagged token (the hint)")
	// And the candidate.
	require.Contains(t, llm.gotPrompt.System, "sad",
		"escalation prompt must contain the candidate")
	// Sanity: the call received the spelling hint, not a different suggestion.
	require.Len(t, pb.lastHints, 1)
	require.Equal(t, "sad", pb.lastHints[0].Replacement)
}

// (b) flag OFF (default) -> BuildWithSpellingHints is NEVER called. The LLM
// receives Build(req).System byte-identical to the legacy baseline.
func TestFastHintsFlagOffNeverCallsBuildWithSpellingHints(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelHarper),
		sugs: []Suggestion{
			{Span: Span{0, 5}, Replacement: "sad", Model: ModelHarper, Category: CategorySpelling, Confidence: 0.3},
		},
	}
	pb := &spikePB{plainSystem: "base-grammar-system"}
	llm := &capturingLLM{out: "I went to the store"}
	svc := NewService(pb, []Corrector{fc}, llm, st, "m", fastPolicy())
	// No SetFastHintsEnabled call -> default false.
	_, err := svc.Correct(context.Background(), Request{Text: "sdasd went to the store"})
	require.NoError(t, err)
	require.Equal(t, 0, pb.hintsCalls,
		"BuildWithSpellingHints must NOT be called when flag is OFF (default)")
	require.Equal(t, "base-grammar-system", llm.gotPrompt.System,
		"LLM must receive the plain Build(req) system prompt byte-identical to the legacy baseline")
}

// (c) flag ON but the fast path produced zero SPELLING-category edits ->
// BuildWithSpellingHints is still called, but with an empty hints slice, and
// the rendered prompt is byte-identical to plain Build(req) (no hint block
// appended).
func TestFastHintsFlagOnNoSpellingEditsUsesPlainBuild(t *testing.T) {
	st := &fakeStore{}
	// A non-spelling fast edit (GECToR grammar, low conf -> escalates, but
	// no CategorySpelling entries so the hint set is empty).
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{
			{Span: Span{0, 4}, Replacement: "X", Model: ModelGECToR, Category: CategoryGrammar, Confidence: 0.3},
		},
	}
	pb := &spikePB{plainSystem: "base-grammar-system"}
	llm := &capturingLLM{out: "I have a cat"}
	svc := NewService(pb, []Corrector{fc}, llm, st, "m", fastPolicy())
	svc.SetFastHintsEnabled(true)
	_, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.Equal(t, 1, pb.hintsCalls,
		"BuildWithSpellingHints must be called when flag is ON, even with no spelling edits (so the LLM still gets the deterministic prompt)")
	require.Empty(t, pb.lastHints, "spelling-only filter must drop non-spelling fast edits")
	require.Equal(t, "base-grammar-system", llm.gotPrompt.System,
		"empty-hint rendering must be byte-identical to plain Build(req) System")
}

// ---- word-granularity merge (GF_MERGE_FAST_EDITS *-word spike) ----
// Refinement of the rejected span-level merge: conflict is decided on
// whitespace-delimited WORD zones, with a zero-width insertion claiming BOTH
// flanking words — so the "same logical insertion at a different offset"
// kill class ("listen to to me") now conflicts and the LLM wins.

func TestWordZonesConflictInsertionsFlankSameWords(t *testing.T) {
	text := "you listen me now"
	// LLM inserts " to" after "listen" (offset 10); the fast path inserts
	// "to " before "me" (offset 11). Different offsets, no span overlap —
	// but both claim the words "listen"/"me", so they must conflict.
	require.True(t, wordZonesConflict(text, Span{10, 10}, Span{11, 11}),
		"insertions flanking the same words must conflict")
	// An edit on "now" does not touch the "listen"/"me" zone.
	require.False(t, wordZonesConflict(text, Span{10, 10}, Span{14, 17}),
		"edits in unrelated words must not conflict")
	// Two edits inside the same word always conflict.
	require.True(t, wordZonesConflict(text, Span{4, 6}, Span{7, 9}),
		"edits inside one word must conflict")
	// Invalid spans are never mergeable (conservative: conflict).
	require.True(t, wordZonesConflict(text, Span{4, 6}, Span{40, 50}),
		"invalid spans must report conflict so they are never merged")
}

func TestCorrectMergeWordDropsDoubleInsertion(t *testing.T) {
	// The measured kill class 1 (golden 42/76/77): the LLM and the fast
	// path make the SAME logical insertion at DIFFERENT offsets. Span
	// geometry let both through ("you listen to to me"); word zones must
	// drop the fast one.
	st := &fakeStore{}
	fast := []Suggestion{
		// GECToR: insert " to" AFTER "listen" (zero-width at 10).
		{Span: Span{10, 10}, Replacement: " to", Model: ModelGECToR, Confidence: 0.3},
	}
	// LLM output inserts "to " BEFORE "me" — a different offset.
	svc := mergeTestService(st, fast, "you listen to me", "gector-word")
	got, err := svc.Correct(context.Background(), Request{Text: "you listen me"})
	require.NoError(t, err)
	require.Equal(t, "you listen to me", st.lastEvent.Suggestion,
		"no double-applied insertion under word-zone conflict")
	for _, s := range got.Suggestions {
		require.Equal(t, ModelLLM, s.Model, "flanking fast insertion dropped")
	}
}

func TestCorrectMergeWordAddsEditOnLLMSilentWord(t *testing.T) {
	// Class 2 documentation: a fast edit on a word the LLM left alone DOES
	// merge under word zones (this is the deliberate recall trade the spike
	// measures — word geometry cannot tell "missed" from "preserved").
	st := &fakeStore{}
	fast := []Suggestion{
		{Span: Span{2, 5}, Replacement: "had", Model: ModelGECToR, Confidence: 0.3},    // same word as LLM has->have
		{Span: Span{12, 15}, Replacement: "cats", Model: ModelGECToR, Confidence: 0.3}, // LLM silent here
	}
	svc := mergeTestService(st, fast, "I have a big cat", "gector-word")
	got, err := svc.Correct(context.Background(), Request{Text: "I has a big cat"})
	require.NoError(t, err)
	var gectorEdits []Suggestion
	for _, s := range got.Suggestions {
		if s.Model == ModelGECToR {
			gectorEdits = append(gectorEdits, s)
		}
	}
	require.Len(t, gectorEdits, 1, "only the LLM-silent-word fast edit merges")
	require.Equal(t, Span{12, 15}, gectorEdits[0].Span)
	require.Equal(t, "I have a big cats", st.lastEvent.Suggestion)
}

func TestCorrectMergeAllWordIncludesHarper(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{name: string(ModelHarper), sugs: []Suggestion{
		{Span: Span{12, 15}, Replacement: "hat", Model: ModelHarper, Category: CategorySpelling, Confidence: 0.3},
	}}
	svc := NewService(fakePB{}, []Corrector{fc}, fakeLLM{out: "I have a big cat"}, st, "m", fastPolicy())
	svc.SetMergeFastEditsMode(MergeFastEditsAllWord)
	got, err := svc.Correct(context.Background(), Request{Text: "I has a big cat"})
	require.NoError(t, err)
	models := map[Model]bool{}
	for _, s := range got.Suggestions {
		models[s.Model] = true
	}
	require.True(t, models[ModelHarper], "all-word mode merges harper edits on LLM-silent words")
}

func TestCorrectMergeWordSameWordReplacementConflicts(t *testing.T) {
	// A fast REPLACEMENT inside a word the LLM edited (even a different
	// byte range of it) must be dropped — the LLM owns the whole word.
	st := &fakeStore{}
	fast := []Suggestion{
		// "big" -> "bigger" via a fast edit on [9,12); the LLM edits the
		// SAME word's first byte (b->B below). Word zones collide.
		{Span: Span{9, 12}, Replacement: "bigger", Model: ModelGECToR, Confidence: 0.3},
	}
	svc := mergeTestService(st, fast, "I has a Big cat", "gector-word")
	got, err := svc.Correct(context.Background(), Request{Text: "I has a big cat"})
	require.NoError(t, err)
	for _, s := range got.Suggestions {
		require.Equal(t, ModelLLM, s.Model, "same-word fast replacement dropped")
	}
}

func TestServiceCorrectMultilineYieldsNoNewlineTouchingSuggestion(t *testing.T) {
	// A fake LLM that "rewrites" the line break the bug report describes:
	// collapses "line one\nline two" -> "Line one. Line two" (capitalize +
	// period + '\n' -> ' '). The pre-fix pipeline would emit a single
	// suggestion whose span contains the '\n'; the post-fix pipeline
	// segments per line, so the LLM is called per line, the diff can't
	// span the '\n', and no surviving suggestion touches the '\n' byte.
	//
	// The fake LLM is per-line by construction: each call is on a
	// sentence-scoped req (see service.go:223 — `sentence := req.Text[seg.Start:seg.End]`).
	// The LLM is given a fragment of text containing no '\n', so its
	// "echo back a re-punctuated form" output produces a diff that lives
	// entirely inside that fragment and never crosses a '\n' in the
	// ORIGINAL text (the LLM has no idea the fragment came from a multi-
	// line source).
	st := &fakeStore{}
	llm := llmFunc(func(_ context.Context, p Prompt) (string, error) {
		// Pre-fix: the LLM was called once on the whole multi-line text and
		// could return "Line one. Line two" — a diff whose span contained
		// the '\n'. Post-fix: the LLM is called once per line, and the
		// sentence fed in is "line one" or "line two" — neither has a '\n'
		// to begin with, so the diff can't cross one.
		// We return a benign "no edit" — a single trailing-space tidy that
		// lives entirely inside the fragment.
		return strings.TrimRight(p.User, " ") + " ", nil
	})
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	svc.SetSentenceCache(64)
	text := "line one\nline two"
	got, err := svc.Correct(context.Background(), Request{Text: text})
	require.NoError(t, err)
	for i, s := range got.Suggestions {
		sp := s.Span
		require.GreaterOrEqual(t, sp.Start, 0)
		require.LessOrEqual(t, sp.End, len(text))
		require.Greater(t, sp.End, sp.Start, "suggestion %d has empty span", i)
		for j := sp.Start; j < sp.End; j++ {
			require.NotEqual(t, byte('\n'), text[j],
				"suggestion %d span [%d,%d) contains '\\n' at byte %d — the bug",
				i, sp.Start, sp.End, j)
		}
	}
}

func TestServiceCorrectMultilineKeepsSentenceCacheHits(t *testing.T) {
	// Sanity: pre-splitting on '\n' must not poison the per-sentence cache.
	// Each line is a separate cache entry; the SECOND call with the same
	// text must not add any new LLM calls (cache hits on both lines).
	st := &fakeStore{}
	llm := &countingLLM{}
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	svc.SetSentenceCache(64)
	text := "line one\nline two"
	_, err := svc.Correct(context.Background(), Request{Text: text})
	require.NoError(t, err)
	first := llm.calls
	require.Equal(t, 2, first, "two lines => two LLM calls cold")
	_, err = svc.Correct(context.Background(), Request{Text: text})
	require.NoError(t, err)
	require.Equal(t, first, llm.calls, "warm: zero additional LLM calls (both lines cached)")
}

func TestServiceCorrectMultilineCacheOffYieldsNoNewlineTouchingSuggestion(t *testing.T) {
	// The newline fix must hold even when the per-sentence cache is
	// disabled (GF_SENTENCE_CACHE_SIZE=0). Pre-fix, the guard
	// `s.sentenceCache == nil || len(segs) < 2` routed multi-line input
	// through the whole-text path when the cache was nil, so a single
	// '\n'-crossing suggestion could be emitted. Post-fix, the per-segment
	// path runs regardless of the cache (sentenceCache.get/add are nil-
	// safe; the per-segment loop simply recomputes each segment).
	//
	// The LLM deliberately emulates the bug-report rewrite ONLY when it
	// sees the whole multi-line text (the pre-fix code path). When it's
	// called per-line (no '\n' in the input), it returns a benign
	// fragment-local edit, so no suggestion crosses a '\n' in the
	// original.
	st := &fakeStore{}
	llm := llmFunc(func(_ context.Context, p Prompt) (string, error) {
		if strings.Contains(p.User, "\n") {
			// Pre-fix: LLM is called once on the whole multi-line text
			// and returns the bug-report rewrite — a diff that, vs the
			// ORIGINAL "line one\nline two", contains a suggestion whose
			// span crosses the '\n' at byte 8 (the "\n" -> " " edit).
			return "Line one. Line two", nil
		}
		// Post-fix: per-segment call, fragment has no '\n'. Return a
		// benign trailing-space tidy that lives entirely inside the
		// fragment.
		return strings.TrimRight(p.User, " ") + " ", nil
	})
	svc := NewService(fakePB{}, nil, llm, st, "m", fastPolicy())
	// Intentionally do NOT call SetSentenceCache — sentenceCache stays nil.
	text := "line one\nline two"
	got, err := svc.Correct(context.Background(), Request{Text: text})
	require.NoError(t, err)
	for i, s := range got.Suggestions {
		sp := s.Span
		require.GreaterOrEqual(t, sp.Start, 0)
		require.LessOrEqual(t, sp.End, len(text))
		require.Greater(t, sp.End, sp.Start, "suggestion %d has empty span", i)
		for j := sp.Start; j < sp.End; j++ {
			require.NotEqual(t, byte('\n'), text[j],
				"suggestion %d span [%d,%d) contains '\\n' at byte %d — the bug (cache-off path)",
				i, sp.Start, sp.End, j)
		}
	}
}

// Task 6: AnalyzeTone (field granularity, cached). Uses pickyPB because
// fakePB's BuildTone returns the GRMR-native skip signal (empty User) and we
// need the LLM to actually be called to verify the result.
func TestServiceAnalyzeToneField(t *testing.T) {
	svc := NewService(pickyPB{}, nil, fakeLLM{out: `{"tags":[{"tag":"frustrated","confidence":0.8}]}`}, &fakeStore{}, "m", fastPolicy())
	svc.SetToneConfig(true, 0)
	svc.SetToneCache(8)
	got, err := svc.AnalyzeTone(context.Background(), ToneRequest{Text: "ugh fine", Granularity: ToneGranularityField, Source: SourceVencord})
	require.NoError(t, err)
	require.Equal(t, []ToneTag{{"frustrated", 0.8}}, got.Tags)
	require.Nil(t, got.Sentences)
}

// Disabled gate short-circuits before any prompt build / LLM call. fakePB is
// fine here because the gate fires before BuildTone is consulted.
func TestServiceAnalyzeToneDisabled(t *testing.T) {
	svc := NewService(fakePB{}, nil, fakeLLM{out: `{"tags":[]}`}, &fakeStore{}, "m", fastPolicy())
	got, err := svc.AnalyzeTone(context.Background(), ToneRequest{Text: "hi", Granularity: ToneGranularityField})
	require.NoError(t, err)
	require.Empty(t, got.Tags)
}

// MinChars floor returns empty without calling the LLM. Gate runs after
// build (ToneEnabled must be true for the floor check to apply); the floor
// is reached before LLM dispatch, so the GRMR-native skip signal in fakePB
// never runs.
func TestServiceAnalyzeToneMinChars(t *testing.T) {
	svc := NewService(pickyPB{}, nil, fakeLLM{out: `{"tags":[{"tag":"friendly","confidence":1}]}`}, &fakeStore{}, "m", fastPolicy())
	svc.SetToneConfig(true, 80)
	got, err := svc.AnalyzeTone(context.Background(), ToneRequest{Text: "short", Granularity: ToneGranularityField})
	require.NoError(t, err)
	require.Empty(t, got.Tags, "below ToneMinChars => empty, no LLM call")
}

// Sentence granularity: per-sentence spans + aggregated field tags. pickyPB
// is required so BuildTone returns a non-empty User.
func TestServiceAnalyzeToneSentence(t *testing.T) {
	svc := NewService(pickyPB{}, nil, fakeLLM{out: `{"tags":[{"tag":"direct","confidence":0.7}]}`}, &fakeStore{}, "m", fastPolicy())
	svc.SetToneConfig(true, 0)
	svc.SetToneCache(8)
	got, err := svc.AnalyzeTone(context.Background(), ToneRequest{Text: "Stop that. Do this now.", Granularity: ToneGranularitySentence})
	require.NoError(t, err)
	require.NotEmpty(t, got.Sentences)
	require.Equal(t, []ToneTag{{"direct", 0.7}}, got.Tags, "aggregate of sentence tags")
	for _, s := range got.Sentences {
		require.GreaterOrEqual(t, s.End, s.Start)
	}
}

// Unparseable LLM output is a soft empty, never an error (tone is advisory).
func TestServiceAnalyzeToneBadLLMSoftEmpty(t *testing.T) {
	svc := NewService(pickyPB{}, nil, fakeLLM{out: "not json"}, &fakeStore{}, "m", fastPolicy())
	svc.SetToneConfig(true, 0)
	got, err := svc.AnalyzeTone(context.Background(), ToneRequest{Text: "hello there friend", Granularity: ToneGranularityField})
	require.NoError(t, err, "unparseable LLM output => soft empty, never an error")
	require.Empty(t, got.Tags)
}

// The /synonyms endpoint serves a payload only when GF_SYNONYMS_ENABLED is
// true. When the flag is false, Service.Synonyms must return nil WITHOUT
// consulting the thesaurus at all — the feature is off the wire for the
// caller and the dataset must not be touched (the bypass is load-bearing for
// the "thesaurus absent on disk + feature disabled" boot path). The thesaurus
// is loaded from a real temp file with a known word so a non-bypass path
// would return non-empty synonyms — empty result under the disabled flag
// proves the thesaurus was NOT consulted.
func TestServiceSynonymsDisabled(t *testing.T) {
	th, err := thesaurus.Load(writeMobyTempFile(t))
	require.NoError(t, err)
	require.NotEmpty(t, th.Lookup("happy"), "sanity: the test fixture must have synonyms for 'happy' so a non-bypass path would return non-empty")
	svc := NewService(fakePB{}, nil, fakeLLM{}, &fakeStore{}, "m", fastPolicy())
	svc.SetThesaurus(th)
	svc.SetSynonymsConfig(false) // disabled
	got, err := svc.Synonyms(context.Background(), "happy")
	require.NoError(t, err)
	require.Nil(t, got, "disabled => bypass; thesaurus is not consulted and nil is returned so the handler renders []")
}

// Service.Synonyms must be nil-safe: a nil *thesaurus.Thesaurus (the
// "dataset not loaded yet" boot state) must return nil without panicking.
// The thesaurus.Lookup method is itself nil-safe — but the bypass is also
// independent of the flag, so a nil thesaurus with the flag on still
// returns nil. The contract: nil in, nil out, no panic.
func TestServiceSynonymsNilThesaurus(t *testing.T) {
	svc := NewService(fakePB{}, nil, fakeLLM{}, &fakeStore{}, "m", fastPolicy())
	// SetThesaurus NOT called — service.thesaurus is the zero-value nil.
	svc.SetSynonymsConfig(true) // flag on; nil thesaurus must still be safe
	got, err := svc.Synonyms(context.Background(), "happy")
	require.NoError(t, err)
	require.Nil(t, got, "nil thesaurus + flag on => nil, no panic (boot path before SetThesaurus)")
}

// ---- semantic verifier gate ----
// A SemanticVerifier scores how much meaning two texts share (0..1). When
// the service is configured with one and the score drops below threshold,
// the LLM rewrite is discarded before diffing. The verifier fails OPEN:
// missing verifier, identical text, or verifier error all pass the LLM
// output through. On rejection the escalation default arm keeps the
// fast-path suggestion set; the LLM-only arm yields empty suggestions but
// still reaches the picky style pass — the rejection never short-circuits
// either branch.

type fakeVerifier struct {
	sim float64
	err error
}

func (f fakeVerifier) Similarity(_ context.Context, _, _ string) (float64, error) {
	return f.sim, f.err
}

func hasLLMSuggestion(sugs []Suggestion) bool {
	for _, s := range sugs {
		if s.Model == ModelLLM {
			return true
		}
	}
	return false
}

// Escalation site: a low-confidence fast edit forces escalation; the LLM
// returns a totally unrelated sentence; the verifier (sim=0.10, threshold
// 0.80) rejects. The fast-path suggestion survives; the rejected LLM diff
// must not appear in the result.
func TestSemanticVerifierDiscardsLowSimilarityRewrite(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Confidence: 0.3}},
	}
	llm := &scriptedLLM{grammarOut: "Completely unrelated sentence."}
	svc := NewService(pickyPB{}, []Corrector{fc}, llm, st, "m", fastPolicy())
	svc.SetSemanticVerifier(fakeVerifier{sim: 0.10}, 0.80)
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.False(t, hasLLMSuggestion(got.Suggestions),
		"rejected LLM rewrite must not appear in suggestions")
	for _, s := range got.Suggestions {
		require.NotEqual(t, ModelLLM, s.Model, "no ModelLLM suggestions after rejection")
	}
}

// High similarity passes through the verifier unchanged; the LLM diff
// reaches the suggestion set as in the legacy baseline.
func TestSemanticVerifierPassesHighSimilarityRewrite(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Confidence: 0.3}},
	}
	llm := &scriptedLLM{grammarOut: "I have a cat"}
	svc := NewService(pickyPB{}, []Corrector{fc}, llm, st, "m", fastPolicy())
	svc.SetSemanticVerifier(fakeVerifier{sim: 0.97}, 0.80)
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.True(t, hasLLMSuggestion(got.Suggestions),
		"high-similarity rewrite must reach the diff")
}

// Verifier error must fail OPEN: the LLM output is passed through, not
// silently rejected. A flaky verifier is preferable to swallowing good
// rewrites (the whole gate exists to reject low-similarity rewrites, not
// to add another way to drop good ones).
func TestSemanticVerifierErrorFailsOpen(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Confidence: 0.3}},
	}
	llm := &scriptedLLM{grammarOut: "I have a cat"}
	svc := NewService(pickyPB{}, []Corrector{fc}, llm, st, "m", fastPolicy())
	svc.SetSemanticVerifier(fakeVerifier{err: errors.New("verifier down")}, 0.80)
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat"})
	require.NoError(t, err)
	require.True(t, hasLLMSuggestion(got.Suggestions),
		"verifier error must fail open; LLM rewrite is kept")
}

// LLM-only site + picky=true: when the verifier rejects the LLM grammar
// rewrite, the grammar path yields empty suggestions but the picky style
// pass must still run. scriptedLLM dispatches by System: Build returns
// System:"grammar" (pickyPB), BuildStyle returns System:"style". The style
// branch returns styleOut; the grammar branch returns grammarOut.
func TestSemanticVerifierRejectionKeepsPickyStylePass(t *testing.T) {
	st := &fakeStore{}
	llm := &scriptedLLM{
		grammarOut: "Completely unrelated sentence.",
		styleOut:   "I has a kitty",
	}
	svc := NewService(pickyPB{}, nil, llm, st, "m", fastPolicy())
	svc.SetSemanticVerifier(fakeVerifier{sim: 0.10}, 0.80)
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat", Picky: true})
	require.NoError(t, err)
	var styleCount, grammarLLMCount int
	for _, s := range got.Suggestions {
		if s.Category == CategoryStyle {
			styleCount++
		} else if s.Model == ModelLLM {
			grammarLLMCount++
		}
	}
	require.Equal(t, 1, styleCount, "style pass must still run after rejection")
	require.Equal(t, 0, grammarLLMCount, "rejected grammar rewrite must not appear")
}

// Escalation site + picky=true (the load-bearing invariant the council pinned
// down): a low-confidence fast edit forces escalation; the LLM grammar
// output is rejected by the verifier; the fast-path suggestion survives;
// and the picky style pass STILL runs. Catches an early-return regression
// in the escalation-arm gate that would silently drop the style pass.
func TestSemanticVerifierEscalationRejectionKeepsPickyStylePass(t *testing.T) {
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Confidence: 0.3}},
	}
	llm := &scriptedLLM{
		grammarOut: "Completely unrelated sentence.", // verifier rejects
		styleOut:   "I has a kitty",                  // valid, non-overlapping style edit
	}
	svc := NewService(pickyPB{}, []Corrector{fc}, llm, st, "m", fastPolicy())
	svc.SetSemanticVerifier(fakeVerifier{sim: 0.10}, 0.80)
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat", Picky: true})
	require.NoError(t, err)
	var fastCount, styleCount, grammarLLMCount int
	for _, s := range got.Suggestions {
		switch {
		case s.Model == ModelGECToR:
			fastCount++
		case s.Category == CategoryStyle:
			styleCount++
		case s.Model == ModelLLM:
			grammarLLMCount++
		}
	}
	require.Equal(t, 1, fastCount, "fast-path suggestion must survive the rejected rewrite")
	require.Equal(t, 1, styleCount, "style pass must still run after escalation-arm rejection")
	require.Equal(t, 0, grammarLLMCount, "rejected LLM grammar rewrite must not appear")
}

// writeMobyTempFile writes a one-line Moby-format dataset containing the
// "happy" headword with 5 synonyms, to a temp file the test owns. Returns
// the path; t.TempDir() cleans up at test exit.
func writeMobyTempFile(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := dir + "/mthesaur.txt"
	require.NoError(t, os.WriteFile(path, []byte("happy,blessed,blissful,blithe,cheerful,content\n"), 0o600))
	return path
}

// ---- Phase D reject suppression (GF_REJECT_SUPPRESSION) ----

// Fast corrector emits a single "setup"->"set up" suggestion. The
// suppression gate (when configured) must drop it deterministically at
// finalize time. WITHOUT the suppressor: the same suggestion survives
// (baseline sanity — the fakeStore path proves we haven't accidentally
// broken the pipeline). WITH the suppressor (pre-warmed so the
// stale-while-revalidate cache is loaded BEFORE the Correct call): the
// suggestion is dropped, leaving the result empty. Pre-warming is the
// test-friendly way to avoid racing the background refresh; a polling
// eventually over the Correct result would work too but couples test
// latency to the refresh goroutine's spawn timing.
func TestRejectSuppressorDropsMatchingFastPathSuggestion(t *testing.T) {
	// Input: "I will setup the server." — "setup" lives at byte 7..12.
	rejected := []EditPair{{Original: "setup", Suggestion: "set up", Count: 4}}
	fcSug := []Suggestion{{
		Span:        Span{7, 12},
		Replacement: "set up",
		Model:       ModelGECToR,
		Confidence:  0.95,
	}}

	// Baseline (no suppressor): the suggestion survives untouched.
	stBase := &fakeStore{}
	fcBase := fakeCorrector{name: string(ModelGECToR), sugs: fcSug}
	svcBase := NewService(fakePB{}, []Corrector{fcBase}, fakeLLM{err: errAlways}, stBase, "m", fastPolicy())
	gotBase, err := svcBase.Correct(context.Background(), Request{Text: "I will setup the server."})
	require.NoError(t, err)
	require.Len(t, gotBase.Suggestions, 1,
		"without the suppressor the fast-path suggestion must survive")
	require.Equal(t, "set up", gotBase.Suggestions[0].Replacement)

	// Suppressor ON: same fake corrector, pre-warm so the rejected pair
	// is loaded into the cache BEFORE Correct is called.
	stSup := &fakeSuppressionStore{
		fakeStore: &fakeStore{},
		data:      PersonalizationData{Rejected: rejected},
	}
	rs := NewRejectSuppressor(stSup, time.Minute)
	require.Eventually(t, func() bool {
		return rs.Suppressed(context.Background(), "setup", "set up")
	}, time.Second, 5*time.Millisecond,
		"pre-warm: the rejected pair must be loaded into the cache before Correct")

	fcSup := fakeCorrector{name: string(ModelGECToR), sugs: fcSug}
	svcSup := NewService(fakePB{}, []Corrector{fcSup}, fakeLLM{err: errAlways}, stSup, "m", fastPolicy())
	svcSup.SetRejectSuppressor(rs)
	gotSup, err := svcSup.Correct(context.Background(), Request{Text: "I will setup the server."})
	require.NoError(t, err)
	require.Empty(t, gotSup.Suggestions,
		"the rejected pair must drop the matching fast-path suggestion")
}

// ---- Phase 1b: parallel fast path (runFast / runFastIncremental) ----

// delayedCorrector is fakeCorrector plus an artificial delay, so tests can
// force a specific completion order (the SLOWEST corrector is listed FIRST
// in s.fast) and prove the concurrent implementation still produces the
// exact same output the old serial "for _, c := range s.fast" loop would
// have, regardless of which goroutine actually finishes first.
type delayedCorrector struct {
	name  string
	sugs  []Suggestion
	err   error
	delay time.Duration
}

func (d delayedCorrector) Name() Model { return Model(d.name) }
func (d delayedCorrector) Correct(_ context.Context, _ Request) ([]Suggestion, error) {
	time.Sleep(d.delay)
	return d.sugs, d.err
}

// TestRunFastConcurrentIsDeterministic proves runFast's concurrent
// implementation is byte-identical to the serial baseline: the FIRST
// corrector (Harper's slot) is made the SLOWEST, so if concatenation order
// were accidentally driven by completion order instead of s.fast's
// configured order, this test would catch the resulting mismatch (a
// different tie-break in mergeSuggestions' stable sort, or a different
// element order on a non-overlapping merge).
func TestRunFastConcurrentIsDeterministic(t *testing.T) {
	harper := delayedCorrector{
		name:  string(ModelHarper),
		delay: 30 * time.Millisecond,
		sugs:  []Suggestion{{Span: Span{0, 3}, Replacement: "Foo", Model: ModelHarper, Confidence: 0.9, Category: CategorySpelling}},
	}
	gector := delayedCorrector{
		name:  string(ModelGECToR),
		delay: 2 * time.Millisecond,
		sugs:  []Suggestion{{Span: Span{4, 7}, Replacement: "bar", Model: ModelGECToR, Confidence: 0.9}},
	}
	svc := NewService(fakePB{}, []Corrector{harper, gector}, fakeLLM{err: errAlways}, &fakeStore{}, "m", fastPolicy())
	req := Request{Text: "xxx yyy"}

	got := svc.runFast(context.Background(), req)

	// Serial baseline: literally the pre-concurrency loop body, computed
	// synchronously in s.fast's configured order.
	var raw []Suggestion
	for _, c := range []Corrector{harper, gector} {
		sugs, err := c.Correct(context.Background(), req)
		require.NoError(t, err)
		raw = append(raw, sugs...)
	}
	want := mergeSuggestions(raw)

	require.Equal(t, want, got, "concurrent runFast must match the serial baseline byte-for-byte")
}

// TestRunFastRecoversPanickingCorrector proves a panicking corrector is
// best-effort (logged, skipped) and never takes down sibling correctors'
// goroutines or the request — extending the existing error-handling
// contract (TestServiceFastPathContinuesOnCorrectorError) to panics, which
// only matters once correctors run in their own goroutines.
type panickyCorrector struct{ name string }

func (p panickyCorrector) Name() Model { return Model(p.name) }
func (p panickyCorrector) Correct(context.Context, Request) ([]Suggestion, error) {
	panic("simulated corrector panic")
}

func TestRunFastRecoversPanickingCorrector(t *testing.T) {
	bad := panickyCorrector{name: string(ModelHarper)}
	good := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{0, 1}, Replacement: "X", Model: ModelGECToR, Confidence: 0.9}},
	}
	svc := NewService(fakePB{}, []Corrector{bad, good}, fakeLLM{err: errAlways}, &fakeStore{}, "m", fastPolicy())

	var got []Suggestion
	require.NotPanics(t, func() {
		got = svc.runFast(context.Background(), Request{Text: "x"})
	})
	require.Len(t, got, 1)
	require.Equal(t, ModelGECToR, got[0].Model)
}

// TestRunFastIncrementalIsDeterministic mirrors
// TestRunFastConcurrentIsDeterministic for the streaming preview path: the
// onFast frames must be emitted in s.fast's configured order (Harper frame,
// then Harper+GECToR combined frame) even though Harper is the slowest
// corrector and GECToR's goroutine finishes first.
func TestRunFastIncrementalIsDeterministic(t *testing.T) {
	harper := delayedCorrector{
		name:  string(ModelHarper),
		delay: 30 * time.Millisecond,
		sugs:  []Suggestion{{Span: Span{0, 3}, Replacement: "Foo", Model: ModelHarper, Confidence: 0.9}},
	}
	gector := delayedCorrector{
		name:  string(ModelGECToR),
		delay: 2 * time.Millisecond,
		sugs:  []Suggestion{{Span: Span{4, 7}, Replacement: "bar", Model: ModelGECToR, Confidence: 0.9}},
	}
	svc := NewService(fakePB{}, []Corrector{harper, gector}, fakeLLM{err: errAlways}, &fakeStore{}, "m", fastPolicy())
	req := Request{Text: "xxx yyy"}

	var frames []Correction
	svc.runFastIncremental(context.Background(), req, func(c Correction) {
		frames = append(frames, c)
	})

	require.Len(t, frames, 2, "one frame per configured corrector")
	require.Equal(t, mergeSuggestions(harper.sugs), frames[0].Suggestions,
		"frame 0 must be Harper alone, in configured order, not whichever corrector finished first")
	combined := append(append([]Suggestion{}, harper.sugs...), gector.sugs...)
	require.Equal(t, mergeSuggestions(combined), frames[1].Suggestions,
		"frame 1 must be the full Harper+GECToR combination")
}

// ---- Phase 1b: singleflight escalation dedup ----

// slowLLM is an LLMClient stub that counts calls and blocks for `delay`
// before returning `out`, so tests can force two concurrent Correct calls
// to actually overlap in time (rather than racing to completion so fast
// the second one never has a chance to observe the first's in-flight call).
type slowLLM struct {
	calls int64
	delay time.Duration
	out   string
}

func (s *slowLLM) Complete(_ context.Context, _ Prompt) (string, error) {
	atomic.AddInt64(&s.calls, 1)
	time.Sleep(s.delay)
	return s.out, nil
}

// TestSingleflightDedupsConcurrentIdenticalWholeTextCorrect proves two
// concurrent Correct calls on the SAME unmodified text (the whole-text
// fallback path, len(segs) < 2 — e.g. two clients/tabs checking the same
// short field, or a debounce race) collapse onto ONE underlying LLM call,
// and BOTH callers still get the correct result.
func TestSingleflightDedupsConcurrentIdenticalWholeTextCorrect(t *testing.T) {
	llm := &slowLLM{delay: 50 * time.Millisecond, out: "I have a cat"}
	svc := NewService(fakePB{}, nil, llm, &fakeStore{}, "m", fastPolicy())

	var wg sync.WaitGroup
	results := make([]Correction, 2)
	errs := make([]error, 2)
	start := make(chan struct{})
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			results[i], errs[i] = svc.Correct(context.Background(), Request{Text: "I has a cat"})
		}(i)
	}
	close(start)
	wg.Wait()

	require.NoError(t, errs[0])
	require.NoError(t, errs[1])
	require.EqualValues(t, 1, atomic.LoadInt64(&llm.calls), "concurrent identical misses must share ONE LLM call")
	for i := range results {
		require.Len(t, results[i].Suggestions, 1, "both callers must still get the corrected result")
		require.Equal(t, "I have a cat", applyAll("I has a cat", results[i].Suggestions),
			"each caller's own copy of the shared singleflight result must apply cleanly")
	}
}

// TestSingleflightDedupsConcurrentIdenticalSentence mirrors the above for
// the sentence-loop path (len(segs) >= 2): two concurrent Correct calls
// sharing an unresolved SENTENCE (not the whole text) still collapse onto
// one correctOnce call for that sentence.
func TestSingleflightDedupsConcurrentIdenticalSentence(t *testing.T) {
	llm := &slowLLM{delay: 50 * time.Millisecond}
	svc := NewService(fakePB{}, nil, llmFunc(func(_ context.Context, p Prompt) (string, error) {
		atomic.AddInt64(&llm.calls, 1)
		time.Sleep(llm.delay)
		return p.User, nil // echo: fakePB puts sentence text verbatim in p.User
	}), &fakeStore{}, "m", fastPolicy())
	svc.SetSentenceCache(64)

	text := "This is the first sentence. This is the second sentence."
	var wg sync.WaitGroup
	errs := make([]error, 2)
	start := make(chan struct{})
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, errs[i] = svc.Correct(context.Background(), Request{Text: text})
		}(i)
	}
	close(start)
	wg.Wait()

	require.NoError(t, errs[0])
	require.NoError(t, errs[1])
	// Two sentences, each checked once across BOTH concurrent requests
	// (echoed text == input, so no correction — but the LLM must still
	// only be called once per distinct sentence, not once per (request,
	// sentence) pair).
	require.EqualValues(t, 2, atomic.LoadInt64(&llm.calls),
		"2 distinct sentences shared across 2 concurrent identical requests must total 2 LLM calls, not 4")
}

// TestCacheMetricsCountsHitsMissesAndDedup exercises Service.CacheMetrics
// end to end: a cold sentence-cache miss followed by a warm hit, plus the
// singleflight dedup counter from the concurrent-sentence test above (run
// fresh here so the count is exact).
func TestCacheMetricsCountsHitsMissesAndDedup(t *testing.T) {
	svc := NewService(fakePB{}, nil, fakeLLM{out: "clean"}, &fakeStore{}, "m", fastPolicy())
	svc.SetSentenceCache(64)
	svc.SetToneCache(64)
	svc.SetCompleteCache(64)

	text := "First sentence here. Second sentence here."
	_, err := svc.Correct(context.Background(), Request{Text: text})
	require.NoError(t, err)
	m := svc.CacheMetrics()
	require.EqualValues(t, 0, m.Sentence.Hits, "cold: every sentence must miss")
	require.EqualValues(t, 2, m.Sentence.Misses)

	_, err = svc.Correct(context.Background(), Request{Text: text})
	require.NoError(t, err)
	m = svc.CacheMetrics()
	require.EqualValues(t, 2, m.Sentence.Hits, "warm: every sentence must hit")
	require.EqualValues(t, 2, m.Sentence.Misses, "misses must not grow on a warm request")

	// No LLM backend implements breakerStater here (fakeLLM is a plain
	// stub), so the metrics block must stay empty rather than panicking.
	require.Empty(t, m.LLMBreakerState)
}
