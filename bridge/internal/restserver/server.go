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

// Handler returns the router with all routes registered explicitly.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /correct", s.handleCorrect)
	mux.HandleFunc("POST /signal", s.handleSignal)
	mux.HandleFunc("GET /stats", s.handleStats)
	return mux
}

// Start blocks serving on cfg.Addr.
func (s *Server) Start() error {
	s.log.Info("rest server listening", "addr", s.cfg.Addr)
	return (&http.Server{Addr: s.cfg.Addr, Handler: s.Handler()}).ListenAndServe()
}
