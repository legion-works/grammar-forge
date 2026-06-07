package restserver

import (
	"encoding/json"
	"net/http"

	"github.com/grammarforge/bridge/internal/correction"
)

// correctRequest is the JSON body for POST /correct (GrammarLLM-compatible).
type correctRequest struct {
	Text   string `json:"text"`
	Source string `json:"source"`
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleCorrect is a STUB in Plan 1A: it echoes the input with no suggestions.
// Plan 1B injects the correction pipeline here.
func (s *Server) handleCorrect(w http.ResponseWriter, r *http.Request) {
	var req correctRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	resp := correction.Correction{
		Original:    req.Text,
		Suggestions: []correction.Suggestion{},
		Score:       100,
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleStats(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"corrections": 0})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
