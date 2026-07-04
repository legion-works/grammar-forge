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

// buildSemanticVerifier returns (nil, no-op) on stub builds. The MiniLM
// verifier needs CGo+ORT (it runs the same hugot session as GECToR); the
// stub build never wires it. When the operator explicitly opted in
// (GF_SEMANTIC_VERIFIER=true) on a stub binary, the silent no-op would be
// confusing — log Warn so the misconfiguration surfaces in the boot log.
func buildSemanticVerifier(cfg config.Config) (correction.SemanticVerifier, func()) {
	if cfg.SemanticVerifierEnabled {
		slog.Warn("semantic verifier requested but this binary was built without CGo+ORT; running without it",
			"model_path", cfg.SemanticVerifierModelPath)
	}
	return nil, func() {}
}
