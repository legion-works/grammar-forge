package restserver

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

type fakeService struct {
	correctOut    correction.Correction
	correctErr    error
	lastSignal    correction.Signal
	lastID        int64
	count         int64
	signalCounts  correction.SignalCounts
	rephraseOut   correction.RephraseResult
	rephraseErr   error
	rephraseSeen  correction.RephraseRequest
	lastCorrect   correction.Request
	fastSugs      []correction.Suggestion
	multiFastSugs [][]correction.Suggestion // when set, onFast is called once per entry
	toneEnabled   bool
	toneOut       correction.ToneResult
	toneErr       error
	// Synonyms stub: enabled flag + canned synonym list. lastWord records
	// the most recent lookup target for assertions.
	synonymsEnabled bool
	synonymsOut     []string
	synonymsErr     error
	lastSynWord     string
}

func (f *fakeService) Correct(_ context.Context, req correction.Request) (correction.Correction, error) {
	f.lastCorrect = req
	return f.correctOut, f.correctErr
}

func (f *fakeService) CorrectStaged(ctx context.Context, req correction.Request, onFast func(correction.Correction)) (correction.Correction, error) {
	if onFast != nil {
		if len(f.multiFastSugs) > 0 {
			for _, sugs := range f.multiFastSugs {
				onFast(correction.Correction{Original: req.Text, Suggestions: sugs, Score: 90})
			}
		} else {
			onFast(correction.Correction{Original: req.Text, Suggestions: f.fastSugs, Score: 90})
		}
	}
	return f.Correct(ctx, req)
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

func (f *fakeService) AnalyzeTone(_ context.Context, _ correction.ToneRequest) (correction.ToneResult, error) {
	return f.toneOut, f.toneErr
}

func (f *fakeService) ToneEnabled() bool { return f.toneEnabled }

func (f *fakeService) Synonyms(_ context.Context, word string) ([]string, error) {
	f.lastSynWord = word
	return f.synonymsOut, f.synonymsErr
}
func (f *fakeService) SynonymsEnabled() bool { return f.synonymsEnabled }

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

// /synonyms contract: returns {word, synonyms:[...]} with HTTP 200. The
// route is always on the wire — unknown words, missing/empty ?word=,
// and a disabled feature all return 200 with an empty array, not 404.
// Clients can iterate `synonyms` without a nil/null check.
func TestSynonymsOK(t *testing.T) {
	svc := &fakeService{synonymsEnabled: true, synonymsOut: []string{"glad", "joyful"}}
	rr := httptest.NewRecorder()
	serve(svc).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/synonyms?word=happy", nil))
	require.Equal(t, http.StatusOK, rr.Code)
	var got struct {
		Word     string   `json:"word"`
		Synonyms []string `json:"synonyms"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
	require.Equal(t, "happy", got.Word)
	require.Equal(t, []string{"glad", "joyful"}, got.Synonyms)
	require.Equal(t, "happy", svc.lastSynWord, "service must receive the requested word")
}

// Unknown word: the handler must NOT 404 — the route stays on the wire
// with 200 + {word, synonyms:[]} so clients can render a "no synonyms"
// affordance without a special-case for missing entries. This is the
// opposite of /tone's disabled=404 contract because the /synonyms
// feature is informational and on by default.
func TestSynonymsUnknownWordEmptyArray(t *testing.T) {
	svc := &fakeService{synonymsEnabled: true, synonymsOut: nil}
	rr := httptest.NewRecorder()
	serve(svc).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/synonyms?word=xyzzy", nil))
	require.Equal(t, http.StatusOK, rr.Code)
	var got struct {
		Synonyms []string `json:"synonyms"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
	require.NotNil(t, got.Synonyms, "synonyms must serialise as [] not null")
	require.Empty(t, got.Synonyms)
}

// Disabled feature (GF_SYNONYMS_ENABLED=false) is still 200 + empty —
// the route is on the wire; the field just has no payload. This keeps
// client rendering logic uniform across the "no data" and "off"
// states.
func TestSynonymsDisabledEmptyArray(t *testing.T) {
	svc := &fakeService{synonymsEnabled: false}
	rr := httptest.NewRecorder()
	serve(svc).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/synonyms?word=happy", nil))
	require.Equal(t, http.StatusOK, rr.Code, "disabled synonyms still 200, never 404")
	var got struct {
		Synonyms []string `json:"synonyms"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
	require.NotNil(t, got.Synonyms)
	require.Empty(t, got.Synonyms)
}

// Missing ?word= is the "absent" case — 200 + empty rather than 400, for
// the same reason: the route always responds with a uniform shape.
func TestSynonymsMissingWordEmptyArray(t *testing.T) {
	svc := &fakeService{synonymsEnabled: true}
	rr := httptest.NewRecorder()
	serve(svc).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/synonyms", nil))
	require.Equal(t, http.StatusOK, rr.Code)
	var got struct {
		Word     string   `json:"word"`
		Synonyms []string `json:"synonyms"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
	require.Equal(t, "", got.Word, "absent word round-trips as the empty string")
	require.Empty(t, got.Synonyms)
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

// ---- SSE /correct/stream ----

// extractSSEEventData returns the data payload of the named event in an SSE
// body, failing the test when the event is absent.
func extractSSEEventData(t *testing.T, body, event string) string {
	t.Helper()
	marker := "event: " + event + "\ndata: "
	i := strings.Index(body, marker)
	require.GreaterOrEqual(t, i, 0, "missing SSE event %q in body:\n%s", event, body)
	rest := body[i+len(marker):]
	end := strings.Index(rest, "\n\n")
	require.GreaterOrEqual(t, end, 0, "unterminated SSE event %q", event)
	return rest[:end]
}

func TestCorrectStreamEmitsFastThenFinal(t *testing.T) {
	svc := &fakeService{
		correctOut: correction.Correction{
			Original: "I has a cat",
			Suggestions: []correction.Suggestion{{
				ID: 7, Span: correction.Span{Start: 2, End: 5},
				Replacement: "have", Model: correction.ModelLLM,
			}},
			Score: 95,
		},
		fastSugs: []correction.Suggestion{{
			Span:        correction.Span{Start: 2, End: 5},
			Replacement: "have", Model: correction.ModelGECToR,
		}},
	}
	srv := New(Config{}, svc)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/correct/stream",
		strings.NewReader(`{"text":"I has a cat","source":"browser"}`))
	srv.Handler().ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "text/event-stream", rec.Header().Get("Content-Type"))
	body := rec.Body.String()
	require.Less(t, strings.Index(body, "event: fast\n"), strings.Index(body, "event: final\n"),
		"fast frame must precede final")

	fastData := extractSSEEventData(t, body, "fast")
	require.Contains(t, fastData, `"stage":"fast"`)
	require.NotContains(t, fastData, `"id"`, "preview suggestions carry no ids")

	finalData := extractSSEEventData(t, body, "final")
	require.Contains(t, finalData, `"id":7`)
	require.NotContains(t, finalData, `"stage"`)
}

func TestCorrectStreamErrorAfterFast(t *testing.T) {
	svc := &fakeService{correctErr: errors.New("backend down")}
	srv := New(Config{}, svc)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/correct/stream",
		strings.NewReader(`{"text":"x y z","source":"browser"}`))
	srv.Handler().ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "stream already started; error travels in-band")
	body := rec.Body.String()
	require.Contains(t, body, "event: fast\n")
	require.Contains(t, body, "event: error\n")
	require.NotContains(t, body, "event: final\n")
	require.Contains(t, extractSSEEventData(t, body, "error"), "unavailable")
}

// TestHandleCorrectStreamEmitsMultipleFastEvents verifies that the SSE handler
// writes one event: fast per onFast invocation when the service emits multiple
// fast frames (incremental multi-frame streaming, T5a). The two fast frames
// must precede the final frame and carry no suggestion IDs.
func TestHandleCorrectStreamEmitsMultipleFastEvents(t *testing.T) {
	svc := &fakeService{
		correctOut: correction.Correction{
			Original: "I has a cat",
			Suggestions: []correction.Suggestion{{
				ID: 7, Span: correction.Span{Start: 2, End: 5},
				Replacement: "have", Model: correction.ModelLLM,
			}},
			Score: 95,
		},
		multiFastSugs: [][]correction.Suggestion{
			// Frame 1: harper result only.
			{{Span: correction.Span{Start: 2, End: 5}, Replacement: "have", Model: correction.ModelHarper}},
			// Frame 2: harper + gector accumulated.
			{
				{Span: correction.Span{Start: 2, End: 5}, Replacement: "have", Model: correction.ModelHarper},
				{Span: correction.Span{Start: 6, End: 8}, Replacement: "a", Model: correction.ModelGECToR},
			},
		},
	}
	srv := New(Config{}, svc)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/correct/stream",
		strings.NewReader(`{"text":"I has a cat","source":"browser"}`))
	srv.Handler().ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()

	// Count fast events.
	fastCount := strings.Count(body, "event: fast\n")
	require.Equal(t, 2, fastCount, "handler must emit one event: fast per onFast invocation")

	// Both fast frames precede the final frame.
	lastFastIdx := strings.LastIndex(body, "event: fast\n")
	finalIdx := strings.Index(body, "event: final\n")
	require.Less(t, lastFastIdx, finalIdx, "all fast frames must precede final")

	// Fast frames carry no suggestion IDs (unlogged previews).
	require.NotContains(t, body[:finalIdx], `"id"`, "fast frame suggestions must carry no IDs")

	// Final frame carries the logged suggestion ID.
	finalData := extractSSEEventData(t, body, "final")
	require.Contains(t, finalData, `"id":7`)

	// Ordinal monotonicity: first fast event appears before second.
	firstFastIdx := strings.Index(body, "event: fast\n")
	require.Less(t, firstFastIdx, lastFastIdx, "fast frames must appear in emission order")
}

func TestCorrectStreamBadJSONIsPlainHTTP400(t *testing.T) {
	srv := New(Config{}, &fakeService{})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/correct/stream", strings.NewReader(`{nope`))
	srv.Handler().ServeHTTP(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.NotContains(t, rec.Body.String(), "event:")
}

func TestCorrectStreamRequiresFlusher(t *testing.T) {
	srv := New(Config{}, &fakeService{})
	rec := httptest.NewRecorder()
	// Wrapping the recorder in an anonymous struct hides its Flush method,
	// so the handler's http.Flusher assertion fails.
	noFlush := struct{ http.ResponseWriter }{rec}
	req := httptest.NewRequest(http.MethodPost, "/correct/stream",
		strings.NewReader(`{"text":"a b c","source":"browser"}`))
	srv.Handler().ServeHTTP(noFlush, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.NotContains(t, rec.Body.String(), "event:")
}

// POST /tone contract: 200 with {tags, sentences?}; tags always non-nil.
func TestToneOK(t *testing.T) {
	svc := &fakeService{
		toneEnabled: true,
		toneOut: correction.ToneResult{
			Tags: []correction.ToneTag{{Tag: "frustrated", Confidence: 0.8}},
		},
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/tone", strings.NewReader(`{"text":"ugh fine whatever","source":"vencord"}`))
	serve(svc).ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	var got toneResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
	require.Equal(t, []toneTagJSON{{Tag: "frustrated", Confidence: 0.8}}, got.Tags)
	require.Empty(t, got.Sentences)
}

// 404 when the feature is disabled — keeps the route off the wire for
// clients that haven't opted in.
func TestToneDisabled(t *testing.T) {
	svc := &fakeService{toneEnabled: false}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/tone", strings.NewReader(`{"text":"hi"}`))
	serve(svc).ServeHTTP(rr, req)
	require.Equal(t, http.StatusNotFound, rr.Code)
}

// 400 on malformed JSON; nothing reaches the service.
func TestToneBadJSON(t *testing.T) {
	svc := &fakeService{toneEnabled: true}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/tone", strings.NewReader(`{`))
	serve(svc).ServeHTTP(rr, req)
	require.Equal(t, http.StatusBadRequest, rr.Code)
}

// 400 on empty text — same contract as /rephrase: required field.
func TestToneEmptyText(t *testing.T) {
	svc := &fakeService{toneEnabled: true}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/tone", strings.NewReader(`{"text":""}`))
	serve(svc).ServeHTTP(rr, req)
	require.Equal(t, http.StatusBadRequest, rr.Code)
}
