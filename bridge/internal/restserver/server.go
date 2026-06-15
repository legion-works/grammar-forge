// Package restserver is the thin HTTP adapter. It maps JSON <-> the correction
// core via the CorrectionService interface and contains no business logic.
package restserver

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/grammarforge/bridge/internal/ltcompat"
)

// maxRequestBodyBytes caps POST bodies. The largest legitimate payload is a
// long /correct text (~64KB of prose is ~10k words — far beyond any field a
// client checks); beyond that is malformed or abusive input that would
// otherwise stream into the JSON decoder and the LLM prompt.
const maxRequestBodyBytes = 256 << 10 // 256 KiB

// CorrectionService is the slice of the correction core the REST layer needs.
type CorrectionService interface {
	Correct(ctx context.Context, req correction.Request) (correction.Correction, error)
	// CorrectStaged is Correct plus a pre-LLM fast-path preview callback,
	// consumed by the SSE /correct/stream handler.
	CorrectStaged(ctx context.Context, req correction.Request, onFast func(correction.Correction)) (correction.Correction, error)
	Signal(ctx context.Context, correctionID int64, signal correction.Signal) error
	CountCorrections(ctx context.Context) (int64, error)
	CountSignals(ctx context.Context) (correction.SignalCounts, error)
	// CountStatsExtended backs the retention field block on /stats
	// (top_issues, streak, words_this_week). The handler always calls it
	// and inlines the result into the response — StatsExtended is
	// additive, never gated, so empty/zero values surface on a fresh
	// install rather than being hidden behind an enable flag.
	CountStatsExtended(ctx context.Context, now time.Time) (correction.StatsExtended, error)
	Rephrase(ctx context.Context, req correction.RephraseRequest) (correction.RephraseResult, error)
	// AnalyzeTone is the tone-detection entry point. ToneEnabled gates the
	// /tone route (404 when off) so the endpoint is off the wire until
	// clients opt in via GF_TONE_ENABLED.
	AnalyzeTone(ctx context.Context, req correction.ToneRequest) (correction.ToneResult, error)
	ToneEnabled() bool
	// Synonyms is the offline thesaurus lookup backing GET /synonyms. The
	// endpoint stays on the wire regardless of SynonymsEnabled — the flag
	// only controls whether a non-empty result is possible. Unknown words
	// return nil; the handler maps that to [] for the JSON shape.
	Synonyms(ctx context.Context, word string) ([]string, error)
	SynonymsEnabled() bool
}

// Config is the subset of settings the REST server needs.
type Config struct {
	Addr string
}

// Server owns the HTTP routing for the bridge's REST API.
type Server struct {
	cfg  Config
	svc  CorrectionService
	log  *slog.Logger
	dict DictionaryStore
}

// DictionaryStore is the slice of the user dictionary the REST layer needs.
// The concrete implementation lives in internal/dictionary; main wires it
// in. nil => routes 503 cleanly.
type DictionaryStore interface {
	Words() []string
	Add(word string) error
	Remove(word string) error
}

// New constructs a Server bound to a correction service.
func New(cfg Config, svc CorrectionService) *Server {
	return &Server{cfg: cfg, svc: svc, log: slog.Default()}
}

// SetDictionary injects the user-dictionary store that backs
// GET/POST/DELETE /dictionary. Optional; when unset the routes 503.
func (s *Server) SetDictionary(d DictionaryStore) { s.dict = d }

// Handler returns the router with all routes registered explicitly, wrapped in
// CORS middleware so browser clients (the extension's content-script fetch, an
// MV3 cross-origin request that triggers a preflight) can call the bridge.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /correct", s.handleCorrect)
	mux.HandleFunc("POST /correct/stream", s.handleCorrectStream)
	mux.HandleFunc("POST /rephrase", s.handleRephrase)
	mux.HandleFunc("POST /tone", s.handleTone)
	mux.HandleFunc("POST /signal", s.handleSignal)
	mux.HandleFunc("GET /stats", s.handleStats)
	mux.HandleFunc("GET /synonyms", s.handleSynonyms)
	mux.HandleFunc("GET /dictionary", s.handleDictionaryList)
	mux.HandleFunc("POST /dictionary", s.handleDictionaryAdd)
	mux.HandleFunc("DELETE /dictionary/{word}", s.handleDictionaryRemove)
	mux.Handle("/v2/", ltcompat.NewHandler(s.svc, "grammarforge"))
	return withCORS(withBodyLimit(mux))
}

// withBodyLimit bounds every request body read. MaxBytesReader makes the
// JSON decoder fail with a read error once the cap is exceeded, which the
// handlers' decodeStrict path already maps to a 400.
func withBodyLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
		}
		next.ServeHTTP(w, r)
	})
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

// Start blocks serving on cfg.Addr. Timeouts: ReadHeaderTimeout defends
// against slowloris; WriteTimeout must exceed the worst-case handler (a
// /rephrase round-trip through a remote reasoning model — the llm clients
// time out at 30s, so 90s leaves margin without ever hanging a conn forever).
func (s *Server) Start() error {
	s.log.Info("rest server listening", "addr", s.cfg.Addr)
	srv := &http.Server{
		Addr:              s.cfg.Addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      90 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	return srv.ListenAndServe()
}
