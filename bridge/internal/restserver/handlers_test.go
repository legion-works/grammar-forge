package restserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

type fakeService struct {
	correctOut   correction.Correction
	correctErr   error
	lastSignal   correction.Signal
	lastID       int64
	count        int64
	signalCounts correction.SignalCounts
	rephraseOut  correction.RephraseResult
	rephraseErr  error
	rephraseSeen correction.RephraseRequest
	lastCorrect  correction.Request
}

func (f *fakeService) Correct(_ context.Context, req correction.Request) (correction.Correction, error) {
	f.lastCorrect = req
	return f.correctOut, f.correctErr
}

func (f *fakeService) Signal(_ context.Context, id int64, s correction.Signal) error {
	f.lastID, f.lastSignal = id, s
	return nil
}
func (f *fakeService) CountCorrections(context.Context) (int64, error) { return f.count, nil }
func (f *fakeService) CountSignals(context.Context) (correction.SignalCounts, error) {
	return f.signalCounts, nil
}

func (f *fakeService) Rephrase(_ context.Context, req correction.RephraseRequest) (correction.RephraseResult, error) {
	f.rephraseSeen = req
	return f.rephraseOut, f.rephraseErr
}

func serve(svc CorrectionService) http.Handler { return New(Config{}, svc).Handler() }

func TestHealthOK(t *testing.T) {
	rr := httptest.NewRecorder()
	serve(&fakeService{}).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/health", nil))
	require.Equal(t, http.StatusOK, rr.Code)
}

// Bridge-native clients (Vencord, OpenCode, the textchecker fork) gate
// premium features on a bridge-side signal. GET /health advertises
// premium:true so the OSS LT build — which drops `software.premium` and
// ignores per-match gRPC `Rule.isPremium` — does not need to be the
// source of truth. The field must serialise as a JSON boolean (not a
// string) so clients can deserialise it into bool.
func TestHealthReportsPremium(t *testing.T) {
	rr := httptest.NewRecorder()
	serve(&fakeService{}).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/health", nil))
	require.Equal(t, http.StatusOK, rr.Code)
	var got struct {
		Status  string `json:"status"`
		Premium bool   `json:"premium"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
	require.Equal(t, "ok", got.Status)
	require.True(t, got.Premium, "premium must be a JSON boolean true")
}

func TestCorrectReturnsSuggestions(t *testing.T) {
	svc := &fakeService{correctOut: correction.Correction{
		Original: "I has a cat",
		Suggestions: []correction.Suggestion{{
			ID: 42, Span: correction.Span{Start: 2, End: 5}, Replacement: "have", Model: correction.ModelLLM,
		}},
		Score: 90,
	}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/correct", strings.NewReader(`{"text":"I has a cat","source":"vencord"}`))
	serve(svc).ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	var got correction.Correction
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
	require.Len(t, got.Suggestions, 1)
	require.Equal(t, int64(42), got.Suggestions[0].ID)
}

func TestCorrectBadJSON(t *testing.T) {
	rr := httptest.NewRecorder()
	serve(&fakeService{}).ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/correct", strings.NewReader("{")))
	require.Equal(t, http.StatusBadRequest, rr.Code)
}

func TestCorrectLLMErrorIs502(t *testing.T) {
	svc := &fakeService{correctErr: context.DeadlineExceeded}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/correct", strings.NewReader(`{"text":"x"}`))
	serve(svc).ServeHTTP(rr, req)
	require.Equal(t, http.StatusBadGateway, rr.Code)
}

func TestSignalRecorded(t *testing.T) {
	svc := &fakeService{}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/signal", strings.NewReader(`{"id":7,"signal":"accepted"}`))
	serve(svc).ServeHTTP(rr, req)
	require.Equal(t, http.StatusNoContent, rr.Code)
	require.Equal(t, int64(7), svc.lastID)
	require.Equal(t, correction.SignalAccepted, svc.lastSignal)
}

func TestStats(t *testing.T) {
	rr := httptest.NewRecorder()
	serve(&fakeService{count: 5}).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/stats", nil))
	require.Equal(t, http.StatusOK, rr.Code)
	require.Contains(t, rr.Body.String(), "5")
}

// /stats surfaces edit-level signal counts and an acceptance rate. The rate is
// accepted / (accepted+rejected+ignored) — the denominator EXCLUDES TotalEdits
// because not every edit has been signalled yet. It is OMITTED from the JSON
// when no signals exist (acceptance rate is undefined, not zero).
func TestStatsReportsEditSignalCountsAndAcceptanceRate(t *testing.T) {
	svc := &fakeService{
		count: 10,
		signalCounts: correction.SignalCounts{
			TotalEdits: 20, Accepted: 2, Rejected: 1, Ignored: 1,
		},
	}
	rr := httptest.NewRecorder()
	serve(svc).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/stats", nil))
	require.Equal(t, http.StatusOK, rr.Code)
	var got struct {
		Corrections    int64    `json:"corrections"`
		EditsTotal     int64    `json:"edits_total"`
		EditsAccepted  int64    `json:"edits_accepted"`
		EditsRejected  int64    `json:"edits_rejected"`
		EditsIgnored   int64    `json:"edits_ignored"`
		AcceptanceRate *float64 `json:"acceptance_rate,omitempty"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
	require.Equal(t, int64(10), got.Corrections)
	require.Equal(t, int64(20), got.EditsTotal)
	require.Equal(t, int64(2), got.EditsAccepted)
	require.Equal(t, int64(1), got.EditsRejected)
	require.Equal(t, int64(1), got.EditsIgnored)
	require.NotNil(t, got.AcceptanceRate, "acceptance_rate must be present when any signal exists")
	require.InDelta(t, 0.5, *got.AcceptanceRate, 1e-9, "2 / (2+1+1) = 0.5")
}

// No signals ever recorded -> acceptance_rate is OMITTED (not 0.0). The field
// would be misleading as zero — zero is a real rate, "no data" is a missing
// field. omitempty on the pointer field is the contract.
func TestStatsOmitsAcceptanceRateWhenNoSignals(t *testing.T) {
	svc := &fakeService{
		count: 0,
		signalCounts: correction.SignalCounts{
			TotalEdits: 5, // edits exist, but none signalled
		},
	}
	rr := httptest.NewRecorder()
	serve(svc).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/stats", nil))
	require.Equal(t, http.StatusOK, rr.Code)
	body := rr.Body.String()
	require.Contains(t, body, `"edits_total":5`)
	require.NotContains(t, body, "acceptance_rate",
		"acceptance_rate must be omitted from JSON when no signals exist")
}

// Rephrase endpoint contract. 200 with {original, rephrased, alternatives}.
// alternatives must be an array (even when empty) so clients can iterate
// without a null check.
func TestRephraseOK(t *testing.T) {
	svc := &fakeService{rephraseOut: correction.RephraseResult{
		Original:     "He go to store.",
		Rephrased:    "He goes to the store.",
		Alternatives: []string{},
	}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/rephrase", strings.NewReader(`{"text":"He go to store.","source":"vencord"}`))
	serve(svc).ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	var got correction.RephraseResult
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
	require.Equal(t, "He go to store.", got.Original)
	require.Equal(t, "He goes to the store.", got.Rephrased)
	require.NotNil(t, got.Alternatives, "alternatives key must serialise as [] not null")
	require.Len(t, got.Alternatives, 0)
}

func TestRephraseBadJSON(t *testing.T) {
	rr := httptest.NewRecorder()
	serve(&fakeService{}).ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/rephrase", strings.NewReader("{")))
	require.Equal(t, http.StatusBadRequest, rr.Code)
}

// Empty text is a 400 (no model call). Tone/style/source remain optional.
func TestRephraseEmptyText(t *testing.T) {
	rr := httptest.NewRecorder()
	serve(&fakeService{}).ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/rephrase", strings.NewReader(`{"text":""}`)))
	require.Equal(t, http.StatusBadRequest, rr.Code)
}

// LLM backend failure is a 502 (bad gateway) — the user's text is unchanged
// and the response carries an error message.
func TestRephraseLLMError(t *testing.T) {
	svc := &fakeService{rephraseErr: context.DeadlineExceeded}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/rephrase", strings.NewReader(`{"text":"x"}`))
	serve(svc).ServeHTTP(rr, req)
	require.Equal(t, http.StatusBadGateway, rr.Code)
}

// `json.NewDecoder.Decode` accepts a valid JSON value followed by trailing
// garbage and returns nil — so a body like `{"text":"hello"} trailing` would
// be silently accepted as a valid request. Locked to 400 across all POST
// handlers via the shared strict-decode helper.
func TestRephraseRejectsTrailingGarbage(t *testing.T) {
	rr := httptest.NewRecorder()
	serve(&fakeService{}).ServeHTTP(rr,
		httptest.NewRequest(http.MethodPost, "/rephrase", strings.NewReader(`{"text":"hello"} trailing`)))
	require.Equal(t, http.StatusBadRequest, rr.Code)
}

func TestCorrectRejectsTrailingGarbage(t *testing.T) {
	rr := httptest.NewRecorder()
	serve(&fakeService{}).ServeHTTP(rr,
		httptest.NewRequest(http.MethodPost, "/correct", strings.NewReader(`{"text":"hello"} trailing`)))
	require.Equal(t, http.StatusBadRequest, rr.Code)
}

func TestSignalRejectsTrailingGarbage(t *testing.T) {
	rr := httptest.NewRecorder()
	serve(&fakeService{}).ServeHTTP(rr,
		httptest.NewRequest(http.MethodPost, "/signal", strings.NewReader(`{"id":1,"signal":"accepted"} trailing`)))
	require.Equal(t, http.StatusBadRequest, rr.Code)
}

// A3: POST /rephrase must accept an optional int `alternatives` and an
// optional `override` object. The override selects a non-default LLM
// backend (provider="openai"|"anthropic"|""=default). The service must
// receive the decoded values; the response must round-trip alternatives
// (always as an array, never null).
func TestRephrasePassesAlternativesAndOverride(t *testing.T) {
	svc := &fakeService{rephraseOut: correction.RephraseResult{
		Original: "x", Rephrased: "y", Alternatives: []string{"z"},
	}}
	body := `{"text":"x","alternatives":2,"override":{"provider":"anthropic","base_url":"u","model":"m","api_key":"k"}}`
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/rephrase", strings.NewReader(body))
	serve(svc).ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	require.Equal(t, 2, svc.rephraseSeen.Alternatives)
	require.NotNil(t, svc.rephraseSeen.Override)
	require.Equal(t, "anthropic", svc.rephraseSeen.Override.Provider)
	require.Equal(t, "u", svc.rephraseSeen.Override.BaseURL)
	require.Equal(t, "m", svc.rephraseSeen.Override.Model)
	require.Equal(t, "k", svc.rephraseSeen.Override.APIKey)
	var got struct {
		Alternatives []string `json:"alternatives"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
	require.Equal(t, []string{"z"}, got.Alternatives)
}

// Unknown provider in the override is a 400 — the handler must reject
// before the service is called (no backend lookup with a bogus name).
func TestRephraseRejectsUnknownProvider(t *testing.T) {
	svc := &fakeService{}
	body := `{"text":"x","override":{"provider":"bogus"}}`
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/rephrase", strings.NewReader(body))
	serve(svc).ServeHTTP(rr, req)
	require.Equal(t, http.StatusBadRequest, rr.Code)
}

// Picky-mode round-trip: POST /correct with {"picky":true} must (a) decode
// the flag, (b) pass it through to the service as correction.Request.Picky,
// and (c) serialise a category:"style" suggestion back in the JSON response
// when the service emits one. The Category field is the wire-level hook
// clients use to distinguish style suggestions from grammar ones.
func TestCorrectPickyRoundTrips(t *testing.T) {
	svc := &fakeService{correctOut: correction.Correction{
		Original: "I has a cat",
		Suggestions: []correction.Suggestion{
			{Span: correction.Span{Start: 2, End: 5}, Replacement: "have", Model: correction.ModelLLM}, // grammar
			{
				Span: correction.Span{Start: 7, End: 10}, Replacement: "kitty", Model: correction.ModelLLM,
				Category: correction.CategoryStyle,
			}, // style
		},
		Score: 80,
	}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/correct", strings.NewReader(`{"text":"I has a cat","picky":true}`))
	serve(svc).ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	require.True(t, svc.lastCorrect.Picky, "service must receive Picky=true")
	require.Contains(t, rr.Body.String(), `"category":"style"`,
		"response JSON must contain the style suggestion's category field")
}

// Default path: picky absent from the request body must decode to false
// and the response must NOT contain a category field on grammar
// suggestions (omitempty drops empty Category). This locks the contract
// that the default /correct path is unchanged for existing clients.
func TestCorrectPickyDefaultsFalse(t *testing.T) {
	svc := &fakeService{correctOut: correction.Correction{
		Original: "I has a cat",
		Suggestions: []correction.Suggestion{
			{Span: correction.Span{Start: 2, End: 5}, Replacement: "have", Model: correction.ModelLLM}, // grammar, no category
		},
		Score: 90,
	}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/correct", strings.NewReader(`{"text":"I has a cat"}`))
	serve(svc).ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	require.False(t, svc.lastCorrect.Picky, "omitted picky must default to false")
	require.NotContains(t, rr.Body.String(), `"category"`,
		"grammar suggestions on the default path must NOT serialise a category field (omitempty)")
}

// TestCorrectCategoryAndReplacementsJSON locks the /correct JSON contract for
// the WS-A additions: a suggestion with Category=CategorySpelling and
// Replacements=["the","tea"] must serialise as `"category":"spelling"` +
// `"replacements":["the","tea"]`; a grammar suggestion (Category="") must
// still OMIT the category field (back-compat). This is the wire-level lock
// clients depend on for the browser extension's colour/alt-replacement UI.
func TestCorrectCategoryAndReplacementsJSON(t *testing.T) {
	svc := &fakeService{correctOut: correction.Correction{
		Original: "teh xxx", //nolint:misspell // intentional fixture
		Suggestions: []correction.Suggestion{
			{
				Span: correction.Span{Start: 0, End: 3}, Replacement: "the",
				Replacements: []string{"the", "tea"}, Model: correction.ModelHarper,
				Category: correction.CategorySpelling,
			},
			{
				Span: correction.Span{Start: 4, End: 7}, Replacement: "ran", Model: correction.ModelGECToR,
				Category: correction.CategoryGrammar,
			},
		},
	}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/correct", strings.NewReader(`{"text":"teh xxx"}`)) //nolint:misspell // intentional fixture
	serve(svc).ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	body := rr.Body.String()
	require.Contains(t, body, `"category":"spelling"`,
		"spelling suggestion must serialise category=spelling")
	require.Contains(t, body, `"replacements":["the","tea"]`,
		"spelling suggestion must serialise full Replacements list")
	// grammar suggestion still omits category:
	require.NotContains(t, body, `"category":"grammar"`,
		"omitempty must drop the empty Category for grammar suggestions")
	require.NotContains(t, body, `"category":""`,
		"omitempty must not serialise an empty-string category at all")
}

// fakeDict is a stub DictionaryStore for the /dictionary route tests. It
// records the last add/remove for assertions; the in-memory words slice is
// the GET response body.
type fakeDict struct {
	words []string
	added string
	del   string
}

func (f *fakeDict) Words() []string       { return f.words }
func (f *fakeDict) Add(w string) error    { f.added = w; f.words = append(f.words, w); return nil }
func (f *fakeDict) Remove(w string) error { f.del = w; return nil }

// The three /dictionary routes:
//
//	GET    /dictionary        — list current words as {"words": [...]}.
//	POST   /dictionary        — body {"word":"x"} append a word; 204 on
//	                            success, 400 on missing/empty word.
//	DELETE /dictionary/{word} — remove a word; 204 on success. The path
//	                            value is URL-decoded by net/http.
func TestDictionaryRoutes(t *testing.T) {
	fd := &fakeDict{words: []string{"alpha", "beta"}}
	srv := New(Config{}, &fakeService{})
	srv.SetDictionary(fd)
	h := srv.Handler()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/dictionary", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	require.JSONEq(t, `{"words":["alpha","beta"]}`, rec.Body.String())

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/dictionary", strings.NewReader(`{"word":"gamma"}`)))
	require.Equal(t, http.StatusNoContent, rec.Code)
	require.Equal(t, "gamma", fd.added)

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/dictionary", strings.NewReader(`{"word":""}`)))
	require.Equal(t, http.StatusBadRequest, rec.Code)

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/dictionary/al%20pha", nil))
	require.Equal(t, http.StatusNoContent, rec.Code)
	require.Equal(t, "al pha", fd.del, "DELETE path value must be URL-decoded by net/http")
}

// When the dictionary store is not injected (no SetDictionary call, e.g. an
// old binary on a host that hasn't been reconfigured), the route must 503
// cleanly rather than dereferencing nil.
func TestDictionaryRoutes503WhenUnset(t *testing.T) {
	srv := New(Config{}, &fakeService{})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/dictionary", nil))
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
}
