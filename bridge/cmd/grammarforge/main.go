// Command grammarforge is the GrammarForge bridge. main loads config, constructs
// dependencies, and starts the listeners — no business logic.
//
// The fast-path correctors (Harper / GECToR) are wired in via a build-tag
// split in fastpath_ort.go (real implementation, needs CGo + ONNX) and
// fastpath_stub.go (no-op stub for CGO_ENABLED=0 builds). This keeps the
// command compilable in CI even without the native libs.
package main

import (
	"log/slog"
	"os"

	"github.com/grammarforge/bridge/internal/config"
	"github.com/grammarforge/bridge/internal/correction"
	"github.com/grammarforge/bridge/internal/llm"
	"github.com/grammarforge/bridge/internal/prompt"
	"github.com/grammarforge/bridge/internal/restserver"
	"github.com/grammarforge/bridge/internal/store"
)

func main() {
	cfg := config.FromOS()
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parseLevel(cfg.LogLevel)})))
	slog.Info("starting grammarforge bridge",
		"rest_addr", cfg.RESTAddr,
		"llm_model", cfg.LLMModel,
		"llm_format", cfg.LLMFormat,
		"harper_enabled", cfg.HarperEnabled,
		"gector_model_dir", cfg.GECToRModelDir,
	)

	st, err := store.Open(cfg.DBPath)
	if err != nil {
		slog.Error("open store", "err", err)
		os.Exit(1)
	}
	defer func() { _ = st.Close() }()

	fast, cleanup := buildFastPath(cfg)
	defer cleanup()

	svc := correction.NewService(
		prompt.New(cfg.LLMFormat),
		fast,
		llm.New(llm.Config{BaseURL: cfg.LLMBaseURL, Model: cfg.LLMModel, APIKey: cfg.LLMAPIKey}),
		st,
		cfg.LLMModel,
		correction.EscalationPolicy{
			MinConfidence:  cfg.EscalateMinConfidence,
			MaxSentenceLen: cfg.EscalateMaxSentenceLen,
		},
	)

	if err := restserver.New(restserver.Config{Addr: cfg.RESTAddr}, svc).Start(); err != nil {
		slog.Error("rest server failed", "err", err)
		os.Exit(1)
	}
}

func parseLevel(s string) slog.Level {
	switch s {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
