// Package restserver is the thin HTTP adapter. It maps JSON <-> the correction
// core and contains no business logic. Routes are registered explicitly (no
// dynamically-built handler names) so every endpoint is greppable.
package restserver

import (
	"log/slog"
	"net/http"
)

// Config is the subset of settings the REST server needs.
type Config struct {
	Addr string
}

// Server owns the HTTP routing for the bridge's REST API.
type Server struct {
	cfg Config
	log *slog.Logger
}

// New constructs a Server. (Model/store dependencies are injected in Plan 1B.)
func New(cfg Config) *Server {
	return &Server{cfg: cfg, log: slog.Default()}
}

// Handler returns the router with all routes registered.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /correct", s.handleCorrect)
	mux.HandleFunc("GET /stats", s.handleStats)
	return mux
}

// Start blocks serving on cfg.Addr.
func (s *Server) Start() error {
	s.log.Info("rest server listening", "addr", s.cfg.Addr)
	srv := &http.Server{Addr: s.cfg.Addr, Handler: s.Handler()}
	return srv.ListenAndServe()
}
