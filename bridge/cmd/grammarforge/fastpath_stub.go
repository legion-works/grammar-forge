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

// buildSemanticVerifier returns nil. The MiniLM verifier needs CGo+ORT (it
// runs the same hugot session as GECToR); the stub build never wires it.
func buildSemanticVerifier(_ config.Config) correction.SemanticVerifier {
	return nil
}
