package correction

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

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

type fakeStore struct {
	lastEvent  Event
	lastSignal Signal
	lastID     int64
	count      int64
}

func (f *fakeStore) LogCorrection(_ context.Context, ev Event) (int64, []int64, error) {
	f.lastEvent = ev
	f.count++
	editIDs := make([]int64, len(ev.Edits))
	for i := range editIDs {
		editIDs[i] = int64(101 + i)
	}
	return 42, editIDs, nil
}

func (f *fakeStore) LogSignal(_ context.Context, id int64, s Signal) error {
	f.lastID, f.lastSignal = id, s
	return nil
}
func (f *fakeStore) CountCorrections(context.Context) (int64, error) { return f.count, nil }
func (f *fakeStore) PersonalizationExamples(context.Context) (PersonalizationData, error) {
	return PersonalizationData{}, nil
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
	long := strings.Repeat("The quick brown fox jumps over the lazy dog. ", 10)
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
	long := strings.Repeat("The quick brown fox jumps over the lazy dog. ", 10)
	svc := NewService(fakePB{}, nil, fakeLLM{out: "The quick."}, &fakeStore{}, "m", fastPolicy())
	_, err := svc.Correct(context.Background(), Request{Text: long})
	require.Error(t, err, "LLM-only path must surface a truncated output as an error, not as mass deletions")
}

func TestCorrectPickyStyleDiscardsSuspiciouslyShortOutput(t *testing.T) {
	st := &fakeStore{}
	// TrimSpace so the grammar pass (which trims its output) sees the input
	// as already-correct and emits NO grammar edits — otherwise a trailing-
	// space grammar edit would swallow the style edits via the overlap rule
	// and this test would pass without the truncation guard.
	long := strings.TrimSpace(strings.Repeat("The quick brown fox jumps over the lazy dog. ", 10))
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
	// No SetSentenceCache -> legacy whole-text path: ONE LLM call.
	_, err := svc.Correct(context.Background(), Request{Text: "One sentence. Two sentences."})
	require.NoError(t, err)
	require.Equal(t, 1, llm.calls)
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

// A multi-word edit that merely contains an allowlisted word is kept — the
// allowlist only suppresses single dictionary words. A larger edit that
// happens to span the allowlisted word is still a real correction.
// Fixture: "kuberntes podz" — bytes [0,14) = the whole string (a multi-word
// span containing a space). The edit is "kuberntes podz" -> "Kubernetes pods";
// it touches the allowlisted word "kubernetes" but is not a single-word
// rewrite, so it survives.
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
