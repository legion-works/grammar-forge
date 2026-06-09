// Package restserver is the thin HTTP adapter. It maps JSON <-> the correction
// core via the CorrectionService interface and contains no business logic.
package restserver

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/grammarforge/bridge/internal/correction"
)

// CorrectionService is the slice of the correction core the REST layer needs.
type CorrectionService interface {
	Correct(ctx context.Context, req correction.Request) (correction.Correction, error)
	Signal(ctx context.Context, correctionID int64, signal correction.Signal) error
	CountCorrections(ctx context.Context) (int64, error)
	Rephrase(ctx context.Context, req correction.RephraseRequest) (correction.RephraseResult, error)
}

// Config is the subset of settings the REST server needs.
type Config struct {
	Addr string
}

// Server owns the HTTP routing for the bridge's REST API.
type Server struct {
	cfg Config
	svc CorrectionService
	log *slog.Logger
}

// New constructs a Server bound to a correction service.
func New(cfg Config, svc CorrectionService) *Server {
	return &Server{cfg: cfg, svc: svc, log: slog.Default()}
}

// Handler returns the router with all routes registered explicitly, wrapped in
// CORS middleware so browser clients (the extension's content-script fetch, an
// MV3 cross-origin request that triggers a preflight) can call the bridge.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /correct", s.handleCorrect)
	mux.HandleFunc("POST /rephrase", s.handleRephrase)
	mux.HandleFunc("POST /signal", s.handleSignal)
	mux.HandleFunc("GET /stats", s.handleStats)
	return withCORS(mux)
}

// withCORS adds permissive CORS headers and answers preflight OPTIONS requests.
// The bridge is local/single-user (bound to loopback/LAN), so allowing any
// origin does not widen exposure beyond who can already reach the port; it lets
// the browser extension's content script (which fetches from arbitrary page
// origins) reach the bridge. No credentials are used, so "*" is valid.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type")
		h.Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Start blocks serving on cfg.Addr.
func (s *Server) Start() error {
	s.log.Info("rest server listening", "addr", s.cfg.Addr)
	return (&http.Server{Addr: s.cfg.Addr, Handler: s.Handler()}).ListenAndServe()
}
