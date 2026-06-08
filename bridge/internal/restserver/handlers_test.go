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
