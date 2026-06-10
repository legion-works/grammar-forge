package ltcompat

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

type fakeService struct{ result correction.Correction }

func (f *fakeService) Correct(context.Context, correction.Request) (correction.Correction, error) {
	return f.result, nil
}

func postCheck(t *testing.T, h http.Handler, form url.Values) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v2/check", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var body map[string]any
	if rec.Code == http.StatusOK {
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	}
	return rec, body
}

func TestCheckHandlerMapsSuggestionsToLTMatches(t *testing.T) {
	text := "café has x"
	svc := &fakeService{result: correction.Correction{
		Original: text,
		Suggestions: []correction.Suggestion{{
			Span:         correction.Span{Start: 5, End: 8},
			Replacement:  "had",
			Replacements: []string{"had", "has had"},
			Model:        correction.ModelLLM,
		}},
	}}
	h := NewHandler(svc, "test-version")
	rec, body := postCheck(t, h, url.Values{"text": {text}, "language": {"en-US"}})
	require.Equal(t, http.StatusOK, rec.Code)

	sw := body["software"].(map[string]any)
	require.Equal(t, "GrammarForge", sw["name"])
	require.Equal(t, true, sw["premium"])

	matches := body["matches"].([]any)
	require.Len(t, matches, 1)
	m := matches[0].(map[string]any)
	require.EqualValues(t, 4, m["offset"], "offset must be UTF-16 units (é = 1 unit, not 2 bytes)")
	require.EqualValues(t, 3, m["length"])
	reps := m["replacements"].([]any)
	require.Len(t, reps, 2)
	require.Equal(t, "had", reps[0].(map[string]any)["value"])
	rule := m["rule"].(map[string]any)
	require.Equal(t, "GF_LLM", rule["id"])
	require.Equal(t, true, rule["isPremium"])
}

func TestCheckHandlerRejectsMissingTextAndDataParam(t *testing.T) {
	h := NewHandler(&fakeService{}, "v")
	rec, _ := postCheck(t, h, url.Values{"language": {"en-US"}})
	require.Equal(t, http.StatusBadRequest, rec.Code)
	rec, _ = postCheck(t, h, url.Values{"data": {`{"annotation":[]}`}, "language": {"en-US"}})
	require.Equal(t, http.StatusBadRequest, rec.Code, "annotated-data requests are unsupported")
}

func TestLanguagesEndpoint(t *testing.T) {
	h := NewHandler(&fakeService{}, "v")
	req := httptest.NewRequest(http.MethodGet, "/v2/languages", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	var langs []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &langs))
	require.NotEmpty(t, langs)
	require.Equal(t, "en-US", langs[0]["longCode"])
}
