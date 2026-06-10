package restserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// MV3 browser-extension content scripts issue a cross-origin POST with
// Content-Type: application/json, which triggers a CORS preflight (OPTIONS).
// The bridge must answer the preflight with 204 and the standard CORS headers
// so the subsequent POST is allowed by the browser. Lock the wire contract.
func TestCORSPreflightReturns204WithHeaders(t *testing.T) {
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/correct", nil)
	req.Header.Set("Origin", "https://example.com")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "Content-Type")
	serve(&fakeService{}).ServeHTTP(rr, req)

	require.Equal(t, http.StatusNoContent, rr.Code)
	require.Equal(t, "*", rr.Header().Get("Access-Control-Allow-Origin"))
	require.Contains(t, rr.Header().Get("Access-Control-Allow-Methods"), "POST")
	require.Contains(t, rr.Header().Get("Access-Control-Allow-Headers"), "Content-Type")
}

// CORS headers must be present on normal responses too — the browser also
// checks Allow-Origin on the actual response, not just the preflight. CORS
// middleware must not alter the response body or status (eval-safe).
func TestCORSHeaderOnNormalResponse(t *testing.T) {
	rr := httptest.NewRecorder()
	serve(&fakeService{}).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/health", nil))
	require.Equal(t, http.StatusOK, rr.Code)
	require.Equal(t, "*", rr.Header().Get("Access-Control-Allow-Origin"))
	require.Contains(t, rr.Body.String(), `"status":"ok"`,
		"health body must be unchanged by CORS wrapping")
}

// Oversized POST bodies must be rejected at the HTTP layer (HTTP 400) so
// they cannot stream into the JSON decoder / LLM prompt. A 5MB /correct
// body is malformed or abusive; the only legitimate input is a long text
// payload (~64KB of prose is ~10k words — far beyond any field a client
// checks). Cap is enforced via http.MaxBytesReader so the decoder fails
// with a read error on overflow, which decodeStrict maps to 400.
func TestHandlerRejectsOversizedBody(t *testing.T) {
	srv := New(Config{Addr: ":0"}, &fakeService{})
	h := srv.Handler()
	big := strings.Repeat("a", maxRequestBodyBytes+1)
	body := `{"text":"` + big + `"}`
	req := httptest.NewRequest(http.MethodPost, "/correct", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code, "oversized body must be rejected, not streamed to the LLM")
}

// The LT-compat sub-handler must be reachable on the same REST mux as the
// bridge-native endpoints (so the LT protocol front door works without a
// separate LanguageTool container). /v2/languages is the cheap smoke test;
// the real /v2/check mapping lives in the ltcompat package's tests.
func TestHandlerMountsLTCompatRoutes(t *testing.T) {
	srv := New(Config{Addr: ":0"}, &fakeService{})
	h := srv.Handler()
	req := httptest.NewRequest(http.MethodGet, "/v2/languages", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
}
