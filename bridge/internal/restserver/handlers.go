package restserver

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/grammarforge/bridge/internal/correction"
)

type correctRequest struct {
	Text   string `json:"text"`
	Source string `json:"source"`
	// Picky enables the best-effort style/clarity pass on top of grammar
	// (Phase-2 P3). Omitted/false is the default — existing clients see no
	// change. When true, the response may include suggestions with
	// category="style" in addition to the usual grammar suggestions.
	Picky bool `json:"picky,omitempty"`
}

type signalRequest struct {
	ID     int64  `json:"id"`
	Signal string `json:"signal"`
}

// rephraseRequest is the JSON shape of POST /rephrase. Tone/Style/Source are
// optional; only Text is required. Alternatives is the requested variant
// count (0 = service default). Override, when present, routes the call to a
// non-default LLM backend (provider must be "" | "openai" | "anthropic").
type rephraseRequest struct {
	Text         string            `json:"text"`
	Tone         string            `json:"tone,omitempty"`
	Style        string            `json:"style,omitempty"`
	Alternatives int               `json:"alternatives,omitempty"`
	Source       string            `json:"source,omitempty"`
	Override     *rephraseOverride `json:"override,omitempty"`
}

// rephraseOverride is the wire shape of the optional backend override on
// /rephrase. api_key is never logged (the service layer's contract).
type rephraseOverride struct {
	Provider string `json:"provider,omitempty"`
	BaseURL  string `json:"base_url,omitempty"`
	Model    string `json:"model,omitempty"`
	APIKey   string `json:"api_key,omitempty"`
}

// rephraseResult is the JSON shape of the /rephrase response. Alternatives
// is reserved for a future variants feature; the slice is always non-nil so
// the field serialises as `[]` rather than `null`.
type rephraseResult struct {
	Original     string   `json:"original"`
	Rephrased    string   `json:"rephrased"`
	Alternatives []string `json:"alternatives"`
}

// healthResponse is the GET /health payload. premium is statically true:
// this is a self-hosted "premium" box. Bridge-native clients
// (Vencord, OpenCode, the textchecker fork) gate premium features on
// this field instead of relying on OSS LanguageTool's /v2/check, which
// drops `software.premium` and the per-match `isPremium` flag unless
// an org.languagetool.PremiumOn class is on the LT classpath.
type healthResponse struct {
	Status  string `json:"status"`
	Premium bool   `json:"premium"`
}

// dictionaryListResponse is the GET /dictionary payload. The words slice is
// always non-nil so the field serialises as `[]` rather than `null`.
type dictionaryListResponse struct {
	Words []string `json:"words"`
}

// dictionaryAddRequest is the POST /dictionary body. Word is required;
// empty-word requests are rejected with 400 before the store is touched.
type dictionaryAddRequest struct {
	Word string `json:"word"`
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, healthResponse{Status: "ok", Premium: true})
}

func (s *Server) handleCorrect(w http.ResponseWriter, r *http.Request) {
	var req correctRequest
	if err := decodeStrict(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	result, err := s.svc.Correct(r.Context(), correction.Request{
		Text: req.Text, Source: correction.Source(req.Source), Picky: req.Picky,
	})
	if err != nil {
		s.log.Error("correct failed", "err", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "correction backend unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleSignal(w http.ResponseWriter, r *http.Request) {
	var req signalRequest
	if err := decodeStrict(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if err := s.svc.Signal(r.Context(), req.ID, correction.Signal(req.Signal)); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// statsResponse is the GET /stats payload. AcceptanceRate is
// accepted/(accepted+rejected+ignored), omitted until at least one signal
// exists. Edit counts come from the edit-level signal log.
type statsResponse struct {
	Corrections    int64    `json:"corrections"`
	EditsTotal     int64    `json:"edits_total"`
	EditsAccepted  int64    `json:"edits_accepted"`
	EditsRejected  int64    `json:"edits_rejected"`
	EditsIgnored   int64    `json:"edits_ignored"`
	AcceptanceRate *float64 `json:"acceptance_rate,omitempty"`
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	n, err := s.svc.CountCorrections(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "stats unavailable"})
		return
	}
	sc, err := s.svc.CountSignals(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "stats unavailable"})
		return
	}
	resp := statsResponse{
		Corrections:   n,
		EditsTotal:    sc.TotalEdits,
		EditsAccepted: sc.Accepted,
		EditsRejected: sc.Rejected,
		EditsIgnored:  sc.Ignored,
	}
	if signaled := sc.Accepted + sc.Rejected + sc.Ignored; signaled > 0 {
		rate := float64(sc.Accepted) / float64(signaled)
		resp.AcceptanceRate = &rate
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleDictionaryList returns the current user-dictionary word list.
// 503 if the store is not injected (SetDictionary never called).
func (s *Server) handleDictionaryList(w http.ResponseWriter, _ *http.Request) {
	if s.dict == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "dictionary unavailable"})
		return
	}
	words := s.dict.Words()
	if words == nil {
		words = []string{}
	}
	writeJSON(w, http.StatusOK, dictionaryListResponse{Words: words})
}

// handleDictionaryAdd appends a word to the user dictionary. 400 on a
// missing/empty word OR a store-side validation error (e.g. the store
// rejects multi-word input). 204 on success. 503 if the store is not set.
func (s *Server) handleDictionaryAdd(w http.ResponseWriter, r *http.Request) {
	if s.dict == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "dictionary unavailable"})
		return
	}
	var req dictionaryAddRequest
	if err := decodeStrict(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if req.Word == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "word is required"})
		return
	}
	if err := s.dict.Add(req.Word); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDictionaryRemove removes a word from the user dictionary. The path
// value is URL-decoded by net/http, so a request to
// /dictionary/al%20pha targets the word "al pha". 204 on success
// (including idempotent removes of unknown words). 503 if the store is
// not set.
func (s *Server) handleDictionaryRemove(w http.ResponseWriter, r *http.Request) {
	if s.dict == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "dictionary unavailable"})
		return
	}
	word := r.PathValue("word")
	if err := s.dict.Remove(word); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleRephrase decodes a rephrase request, delegates to the service, and
// translates errors to HTTP status. The handler does no business logic —
// the service is the source of truth for the LLM call and the response
// shape. Status codes: 200 success, 400 bad JSON or empty text, 502 LLM
// backend error.
func (s *Server) handleRephrase(w http.ResponseWriter, r *http.Request) {
	var req rephraseRequest
	if err := decodeStrict(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if req.Text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text is required"})
		return
	}
	var override *correction.RephraseBackend
	if req.Override != nil {
		switch req.Override.Provider {
		case "", "openai", "anthropic":
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown provider"})
			return
		}
		override = &correction.RephraseBackend{
			Provider: req.Override.Provider,
			BaseURL:  req.Override.BaseURL,
			Model:    req.Override.Model,
			APIKey:   req.Override.APIKey,
		}
	}
	result, err := s.svc.Rephrase(r.Context(), correction.RephraseRequest{
		Text:         req.Text,
		Tone:         req.Tone,
		Style:        req.Style,
		Alternatives: req.Alternatives,
		Override:     override,
		Source:       correction.Source(req.Source),
	})
	if err != nil {
		s.log.Error("rephrase failed", "err", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "rephrase backend unavailable"})
		return
	}
	alts := result.Alternatives
	if alts == nil {
		alts = []string{}
	}
	writeJSON(w, http.StatusOK, rephraseResult{
		Original:     result.Original,
		Rephrased:    result.Rephrased,
		Alternatives: alts,
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// decodeStrict decodes exactly one JSON value from r into v and rejects any
// trailing data after it (so `{...} garbage` is a 400, not silently accepted).
// json.NewDecoder.Decode stops at the first complete value, so a body like
// `{"text":"x"} trailing` would otherwise return nil and the trailing data
// would be ignored — which is a footgun for clients that send extra payload
// by mistake. All POST handlers in this package go through this helper so
// the contract is uniform.
func decodeStrict(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return fmt.Errorf("unexpected trailing data after JSON body")
	}
	return nil
}
