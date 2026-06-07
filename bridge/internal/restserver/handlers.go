package restserver

import (
	"encoding/json"
	"net/http"

	"github.com/grammarforge/bridge/internal/correction"
)

type correctRequest struct {
	Text   string `json:"text"`
	Source string `json:"source"`
}

type signalRequest struct {
	ID     int64  `json:"id"`
	Signal string `json:"signal"`
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleCorrect(w http.ResponseWriter, r *http.Request) {
	var req correctRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	result, err := s.svc.Correct(r.Context(), correction.Request{
		Text: req.Text, Source: correction.Source(req.Source),
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if err := s.svc.Signal(r.Context(), req.ID, correction.Signal(req.Signal)); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	n, err := s.svc.CountCorrections(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "stats unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"corrections": n})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
