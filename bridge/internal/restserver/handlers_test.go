package restserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func newTestServer() *Server { return New(Config{}) }

func TestHealthOK(t *testing.T) {
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	newTestServer().Handler().ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	var body map[string]string
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &body))
	require.Equal(t, "ok", body["status"])
}

func TestCorrectEchoesInput(t *testing.T) {
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/correct",
		strings.NewReader(`{"text":"I has a cat","source":"vencord"}`))
	req.Header.Set("Content-Type", "application/json")
	newTestServer().Handler().ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &body))
	require.Equal(t, "I has a cat", body["original"])
	require.Empty(t, body["suggestions"]) // stub: no models yet
}

func TestCorrectRejectsBadJSON(t *testing.T) {
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/correct", strings.NewReader("{"))
	newTestServer().Handler().ServeHTTP(rr, req)
	require.Equal(t, http.StatusBadRequest, rr.Code)
}
