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
	"github.com/grammarforge/bridge/internal/dictionary"
	"github.com/grammarforge/bridge/internal/llm"
	"github.com/grammarforge/bridge/internal/ltgrpc"
	ltpb "github.com/grammarforge/bridge/internal/ltgrpc/pb"
	"github.com/grammarforge/bridge/internal/personalization"
	"github.com/grammarforge/bridge/internal/prompt"
	"github.com/grammarforge/bridge/internal/restserver"
	"github.com/grammarforge/bridge/internal/store"
	"github.com/grammarforge/bridge/internal/thesaurus"
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

	if err := st.PruneOlderThan(cfg.RetentionDays); err != nil {
		slog.Warn("retention prune failed", "err", err)
	}

	// User dictionary: must be open AND the file must exist on disk before
	// the fast path is built (harper_create_merged_dict reads the path at
	// construction time). Best-effort: a missing or unwriteable file
	// disables the feature (the restserver/dictionary routes 503, the LLM
	// re-flag suppression is a no-op) rather than failing startup.
	dict, err := dictionary.Open(cfg.HarperUserDictPath)
	if err != nil {
		slog.Warn("user dictionary unavailable", "err", err)
		dict = nil
	} else if err := dict.EnsureFile(); err != nil {
		slog.Warn("user dictionary file not creatable; disabling", "err", err)
		dict = nil
	}

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
	// Protected vocabulary: the chat prompts list the user-dictionary words so
	// the LLM stops "correcting" them (the allowlist below only filters output
	// post-hoc). Empty dictionary => byte-identical prompts.
	if dict != nil {
		pb.SetVocabularySource(dict)
	}
	// Seed the configured English dialect into the LLM prompts so the slow path
	// matches Harper's fast-path dialect (e.g. British keeps organise/colour).
	// American (default) appends nothing — the golden-eval baseline is unchanged.
	pb.SetDialect(cfg.HarperDialect)

	svc := correction.NewService(
		pb,
		fast,
		llm.New(llm.Config{BaseURL: cfg.LLMBaseURL, Model: cfg.LLMModel, APIKey: cfg.LLMAPIKey, Seed: cfg.LLMSeed}),
		st,
		cfg.LLMModel,
		correction.EscalationPolicy{
			MinConfidence:          cfg.EscalateMinConfidence,
			MaxSentenceLen:         cfg.EscalateMaxSentenceLen,
			MinWordsForEscalation:  cfg.EscalateMinWords,
			EscalateOnFastEdit:     cfg.EscalateOnFastEdit,
			SkipLLMForSpellingOnly: cfg.SkipLLMForSpellingOnly,
		},
	)
	if cfg.SentenceCacheSize > 0 {
		svc.SetSentenceCache(cfg.SentenceCacheSize)
	}
	// LLM re-flag suppression: the *dictionary.Store satisfies
	// correction.WordAllowlist (Contains) directly — no adapter needed.
	if dict != nil {
		svc.SetWordAllowlist(dict)
	}
	// LLM over-edit repair: deterministic text-level reverts of measured
	// over-edit classes (see internal/correction/overedit.go), applied to
	// LLM grammar output before diffing. Default on; GF_OVEREDIT_FILTER=false
	// restores legacy behaviour.
	if cfg.OverEditFilterEnabled {
		svc.SetOverEditRules(correction.DefaultOverEditRules())
	}
	// Deterministic a/an article fix: applied after the over-edit chain and
	// before diffing. Fixes silent-h words Harper's letter-based AnA rule
	// misses ("a honest"→"an honest", "a hour"→"an hour", etc.). Default on;
	// GF_ARTICLE_FIX=false disables. The full cold golden eval is the FP gate
	// before expanding the silent-h stem list (see internal/correction/article.go).
	svc.SetArticleFix(cfg.ArticleFixEnabled)
	// Harper irregular-plural possessive misfire repair: applied to Harper
	// fast-path suggestions before merging. Replaces confident-wrong
	// possessive suggestions (tooths→tooth's, womans→woman's,
	// luggages→luggage's) with the correct plural (teeth, women, luggage).
	// Default on; GF_IRREGULAR_PLURAL_FIX=false disables.
	svc.SetIrregularPluralFix(cfg.IrregularPluralFixEnabled)
	// Harper mid-sentence capitalization misfire filter: applied to fast-path
	// suggestions per-corrector. Drops capitalization-only edits of
	// unambiguous function words (e.g. on→On, he→He) at non-sentence-start
	// positions. Proper nouns (taipei→Taipei), "i"→"I", and true
	// sentence-start capitalizations are always preserved. Default on;
	// GF_CAPITALIZATION_FIX=false disables.
	svc.SetCapitalizationFix(cfg.CapitalizationFixEnabled)
	// Merge-not-replace escalation composition (experimental spike; default
	// "" keeps the measured replace semantics). See correction.MergeFastEdits*.
	if cfg.MergeFastEditsMode != "" {
		svc.SetMergeFastEditsMode(cfg.MergeFastEditsMode)
	}
	// Fast-hint prompt-injection spike (GF_FAST_HINTS, default off): when
	// on, Harper's SPELLING candidates are appended to the escalation
	// prompt as arbitration hints. SPIKE — keep/revert is gated on the
	// full cold golden eval. The default is unconditional (SetFastHintsEnabled
	// with false is a no-op), so wiring the env flag here is the single
	// switch.
	svc.SetFastHintsEnabled(cfg.FastHintsEnabled)

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

	// Tone analysis reuses the rephrase factory; wire its cache, gate, and
	// optional dedicated backend (GF_TONE_* -> falls back to rephrase -> llm).
	svc.SetToneCache(cfg.ToneCacheSize)
	svc.SetToneConfig(cfg.ToneEnabled, cfg.ToneMinChars)
	svc.SetCompleteEnabled(cfg.CompleteEnabled)
	svc.SetCompleteCache(cfg.CompleteCacheSize)
	svc.SetCompleteTemperature(cfg.CompleteTemperature)
	if cfg.ToneProvider != "" {
		svc.SetToneDefaultBackend(&correction.RephraseBackend{
			Provider: cfg.ToneProvider,
			BaseURL:  cfg.ToneBaseURL,
			Model:    cfg.ToneModel,
			APIKey:   cfg.ToneAPIKey,
		})
	}

	// Offline /synonyms (Moby Thesaurus II, public domain). Loaded once
	// at startup; a missing file is a no-op, not a crash — the route
	// stays on the wire and returns empty arrays until the operator
	// runs bridge/scripts/fetch-thesaurus.sh. Mirrors the user
	// dictionary's "best-effort, log on failure" wiring.
	th, thErr := thesaurus.Load(cfg.ThesaurusPath)
	if thErr != nil {
		slog.Warn("thesaurus load failed; /synonyms returns empty", "path", cfg.ThesaurusPath, "err", thErr)
		th = nil
	} else {
		slog.Info("thesaurus loaded", "path", cfg.ThesaurusPath, "headwords", th.Size())
	}
	svc.SetThesaurus(th)
	svc.SetSynonymsConfig(cfg.SynonymsEnabled)

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

	rest := restserver.New(restserver.Config{Addr: cfg.RESTAddr}, svc)
	if dict != nil {
		rest.SetDictionary(dict)
	}
	if err := rest.Start(); err != nil {
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
