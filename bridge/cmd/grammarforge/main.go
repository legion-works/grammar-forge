// Command grammarforge is the GrammarForge bridge. main only loads config,
// constructs dependencies, and starts the listeners — no business logic.
package main

import (
	"log/slog"
	"os"

	"github.com/grammarforge/bridge/internal/config"
	"github.com/grammarforge/bridge/internal/restserver"
)

func main() {
	cfg := config.FromOS()
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: parseLevel(cfg.LogLevel),
	})))
	slog.Info("starting grammarforge bridge", "rest_addr", cfg.RESTAddr, "llm_model", cfg.LLMModel)

	srv := restserver.New(restserver.Config{Addr: cfg.RESTAddr})
	if err := srv.Start(); err != nil {
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
