// Command grammarforge is the GrammarForge bridge. main loads config, constructs
// dependencies, and starts the listeners — no business logic.
//
// The fast-path correctors (Harper / GECToR) are wired in via a build-tag
// split in fastpath_ort.go (real implementation, needs CGo + ONNX) and
// fastpath_stub.go (no-op stub for CGO_ENABLED=0 builds). This keeps the
// command compilable in CI even without the native libs.
package main

import (
	"fmt"
	"log/slog"
	"net"
	"os"

	"github.com/grammarforge/bridge/internal/config"
	"github.com/grammarforge/bridge/internal/correction"
	"github.com/grammarforge/bridge/internal/llm"
	"github.com/grammarforge/bridge/internal/ltgrpc"
	ltpb "github.com/grammarforge/bridge/internal/ltgrpc/pb"
	"github.com/grammarforge/bridge/internal/personalization"
	"github.com/grammarforge/bridge/internal/prompt"
	"github.com/grammarforge/bridge/internal/restserver"
	"github.com/grammarforge/bridge/internal/store"
	"google.golang.org/grpc"
)

func main() {
	cfg := config.FromOS()
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parseLevel(cfg.LogLevel)})))
	slog.Info(
		"starting grammarforge bridge",
		"rest_addr", cfg.RESTAddr,
		"grpc_addr", cfg.GRPCAddr,
		"llm_model", cfg.LLMModel,
		"llm_format", cfg.LLMFormat,
		"harper_enabled", cfg.HarperEnabled,
		"gector_model_dir", cfg.GECToRModelDir,
		"personalization_enabled", cfg.PersonalizationEnabled,
		"personalization_ttl", cfg.PersonalizationTTL,
	)

	st, err := store.Open(cfg.DBPath)
	if err != nil {
		slog.Error("open store", "err", err)
		os.Exit(1)
	}
	defer func() { _ = st.Close() }()

	fast, cleanup := buildFastPath(cfg)
	defer cleanup()

	// Phase-2 P4 prompt-cache personalisation. On by default; the cache
	// reads the accept/reject signal log with a TTL-cached snapshot, so
	// the prompt builder never blocks on a slow store and a personalisation
	// error never fails a correction. When disabled, the prompt builder
	// keeps using the base system prompt byte-identical to the pre-P4
	// behaviour.
	var pb *prompt.Builder
	if cfg.PersonalizationEnabled {
		cache := personalization.NewCache(st, cfg.PersonalizationTTL)
		pb = prompt.NewWithPersonalizer(cfg.LLMFormat, cache)
	} else {
		pb = prompt.New(cfg.LLMFormat)
	}

	svc := correction.NewService(
		pb,
		fast,
		llm.New(llm.Config{BaseURL: cfg.LLMBaseURL, Model: cfg.LLMModel, APIKey: cfg.LLMAPIKey, Seed: cfg.LLMSeed}),
		st,
		cfg.LLMModel,
		correction.EscalationPolicy{
			MinConfidence:         cfg.EscalateMinConfidence,
			MaxSentenceLen:        cfg.EscalateMaxSentenceLen,
			MinWordsForEscalation: cfg.EscalateMinWords,
			EscalateOnFastEdit:    cfg.EscalateOnFastEdit,
		},
	)

	// Inject the rephrase provider factory (this is where internal/llm is
	// allowed — the correction core stays transport-free). The api_key is
	// never logged (mirrors llm.Config.APIKey).
	svc.SetRephraseFactory(func(b correction.RephraseBackend) (correction.LLMClient, error) {
		lcfg := llm.Config{BaseURL: b.BaseURL, Model: b.Model, APIKey: b.APIKey, Seed: cfg.LLMSeed}
		switch b.Provider {
		case "", "openai":
			return llm.New(lcfg), nil
		case "anthropic":
			return llm.NewAnthropic(lcfg), nil
		default:
			return nil, fmt.Errorf("unknown rephrase provider %q", b.Provider)
		}
	})
	// A configured dedicated rephrase backend (GF_REPHRASE_*) is used when a
	// request carries no per-request override.
	if cfg.RephraseProvider != "" {
		svc.SetRephraseDefaultBackend(&correction.RephraseBackend{
			Provider: cfg.RephraseProvider,
			BaseURL:  cfg.RephraseBaseURL,
			Model:    cfg.RephraseModel,
			APIKey:   cfg.RephraseAPIKey,
		})
	}

	go func() {
		lis, err := net.Listen("tcp", cfg.GRPCAddr)
		if err != nil {
			slog.Error("grpc listen", "err", err)
			os.Exit(1)
		}
		gs := grpc.NewServer()
		ltpb.RegisterMLServerServer(gs, ltgrpc.NewServer(svc))
		slog.Info("grpc server listening", "addr", cfg.GRPCAddr)
		if err := gs.Serve(lis); err != nil {
			slog.Error("grpc serve", "err", err)
		}
	}()

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
