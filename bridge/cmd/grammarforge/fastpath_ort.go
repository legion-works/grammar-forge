//go:build cgo && ORT

package main

import (
	"log/slog"

	"github.com/grammarforge/bridge/internal/config"
	"github.com/grammarforge/bridge/internal/correction"
	"github.com/grammarforge/bridge/internal/gector"
	"github.com/grammarforge/bridge/internal/harperffi"
)

// buildFastPath constructs the in-process fast-path correctors. The Harper
// corrector is created if cfg.HarperEnabled; the GECToR corrector is created
// against cfg.GECToRModelDir (a load failure is logged and the service falls
// back to LLM-only — fast path is best-effort). The returned cleanup closes
// the corrector sessions on shutdown.
func buildFastPath(cfg config.Config) ([]correction.Corrector, func()) {
	var fast []correction.Corrector

	if cfg.HarperEnabled {
		fast = append(fast, harperffi.New())
		slog.Info("fast path: harper enabled")
	}

	if g, err := gector.New(cfg.GECToRModelDir); err != nil {
		slog.Warn("gector unavailable; running without it", "err", err)
	} else {
		fast = append(fast, g)
		slog.Info("fast path: gector loaded", "model_dir", cfg.GECToRModelDir)
	}

	cleanup := func() {
		for _, c := range fast {
			if cl, ok := c.(interface{ Close() error }); ok {
				_ = cl.Close()
			}
		}
	}
	return fast, cleanup
}
