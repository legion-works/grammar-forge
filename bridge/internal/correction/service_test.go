package correction

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

type fakeLLM struct {
	out string
	err error
}

func (f fakeLLM) Complete(context.Context, Prompt) (string, error) { return f.out, f.err }

type fakePB struct{}

func (fakePB) Build(req Request) Prompt { return Prompt{User: req.Text, Template: TemplateGRMRNative} }

func (fakePB) BuildRephrase(req RephraseRequest) Prompt {
	return Prompt{User: req.Text, Template: TemplateGRMRNative}
}

// BuildStyle is the no-op default (matches the real GRMR-native behaviour):
// picky-mode is a chat-model feature, and the existing tests run on a fake
// that uses the GRMR-native format. Tests that need a chat-style style pass
// override the method on their own fakePB instance.
func (fakePB) BuildStyle(req Request) Prompt {
	return Prompt{User: "", Template: TemplateGRMRNative}
}

type fakeStore struct {
	lastEvent  Event
	lastSignal Signal
	lastID     int64
	count      int64
}

func (f *fakeStore) LogCorrection(_ context.Context, ev Event) (int64, error) {
	f.lastEvent = ev
	f.count++
	return 42, nil
}

func (f *fakeStore) LogSignal(_ context.Context, id int64, s Signal) error {
	f.lastID, f.lastSignal = id, s
	return nil
}
func (f *fakeStore) CountCorrections(context.Context) (int64, error) { return f.count, nil }
func (f *fakeStore) Close() error                                    { return nil }

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
	require.Equal(t, int64(42), got.Suggestions[0].ID) // tagged with the logged id
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

func (f *failingStore) LogCorrection(context.Context, Event) (int64, error) {
	return 0, errors.New("db down")
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
		grammarOut: "I have a cat", // change vs input -> diffToSuggestions will emit
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
