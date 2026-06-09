package restserver

import (
	"net/http"
	"net/http/httptest"
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
