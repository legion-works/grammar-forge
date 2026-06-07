//go:build !cgo || !ORT

package main

import (
	"log/slog"

	"github.com/grammarforge/bridge/internal/config"
	"github.com/grammarforge/bridge/internal/correction"
)

// buildFastPath returns no fast-path correctors. This stub is compiled when
// the binary is built without CGo+ORT (CI builds, lite dev environments);
// the service runs in LLM-only mode.
func buildFastPath(_ config.Config) ([]correction.Corrector, func()) {
	slog.Info("fast path disabled (built without cgo+ORT) — LLM-only")
	return nil, func() {}
}
