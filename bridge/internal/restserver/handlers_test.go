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
	correctOut correction.Correction
	correctErr error
	lastSignal correction.Signal
	lastID     int64
	count      int64
}

func (f *fakeService) Correct(context.Context, correction.Request) (correction.Correction, error) {
	return f.correctOut, f.correctErr
}

func (f *fakeService) Signal(_ context.Context, id int64, s correction.Signal) error {
	f.lastID, f.lastSignal = id, s
	return nil
}
func (f *fakeService) CountCorrections(context.Context) (int64, error) { return f.count, nil }

func serve(svc CorrectionService) http.Handler { return New(Config{}, svc).Handler() }

func TestHealthOK(t *testing.T) {
	rr := httptest.NewRecorder()
	serve(&fakeService{}).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/health", nil))
	require.Equal(t, http.StatusOK, rr.Code)
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
