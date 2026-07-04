//go:build cgo && ORT

package main

import (
	"log/slog"

	"github.com/grammarforge/bridge/internal/config"
	"github.com/grammarforge/bridge/internal/correction"
	"github.com/grammarforge/bridge/internal/gector"
	"github.com/grammarforge/bridge/internal/harperffi"
	"github.com/grammarforge/bridge/internal/semverify"
)

// buildFastPath constructs the in-process fast-path correctors. The Harper
// corrector is created if cfg.HarperEnabled; the GECToR corrector is created
// against cfg.GECToRModelDir (a load failure is logged and the service falls
// back to LLM-only — fast path is best-effort). The returned cleanup closes
// the corrector sessions on shutdown.
func buildFastPath(cfg config.Config) ([]correction.Corrector, func()) {
	var fast []correction.Corrector

	if cfg.HarperEnabled {
		fast = append(fast, harperffi.NewWithOptions(harperffi.Options{
			Markdown:        cfg.HarperMarkdown,
			IgnoreLinkTitle: cfg.HarperIgnoreLinkTitle,
			Dialect:         harperffi.DialectCode(cfg.HarperDialect),
			DisabledRules:   cfg.HarperDisabledRules,
			EnabledRules:    cfg.HarperEnabledRules,
			MaxInputLen:     cfg.HarperMaxInputLen,
			UserDictPath:    cfg.HarperUserDictPath,
		}))
		slog.Info("fast path: harper enabled",
			"markdown", cfg.HarperMarkdown,
			"dialect", cfg.HarperDialect,
			"disabled_rules", len(cfg.HarperDisabledRules),
			"enabled_rules", len(cfg.HarperEnabledRules),
			"max_input_len", cfg.HarperMaxInputLen,
			"user_dict", cfg.HarperUserDictPath != "")
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

// buildSemanticVerifier constructs the MiniLM verifier (correction.SemanticVerifier)
// and returns a cleanup that releases its hugot session on shutdown. Mirrors
// the corrector build pattern: a load failure is logged at Warn and (nil,
// no-op) is returned — a broken verifier must never crash startup, since the
// service layer fails OPEN on a nil verifier (same posture as the corrector
// fall-through). The cleanup is always non-nil so the caller can defer it
// without a nil-check (matches buildFastPath's deferred cleanup contract).
func buildSemanticVerifier(cfg config.Config) (correction.SemanticVerifier, func()) {
	v, err := semverify.New(cfg.SemanticVerifierModelPath)
	if err != nil {
		slog.Warn("semantic verifier unavailable; running without it", "err", err, "model_path", cfg.SemanticVerifierModelPath)
		return nil, func() {}
	}
	slog.Info("semantic verifier loaded", "model_path", cfg.SemanticVerifierModelPath, "threshold", cfg.SemanticVerifierThreshold)
	return v, func() { _ = v.Close() }
}
