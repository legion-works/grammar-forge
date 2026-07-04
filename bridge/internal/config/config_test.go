package config

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestLoadDefaults(t *testing.T) {
	c := Load(func(string) (string, bool) { return "", false })
	if c.RESTAddr != ":8000" {
		t.Errorf("RESTAddr = %q, want :8000", c.RESTAddr)
	}
	if c.LLMBaseURL != "http://llamacpp:8000/v1" {
		t.Errorf("LLMBaseURL = %q, want default", c.LLMBaseURL)
	}
	if c.LogLevel != "info" {
		t.Errorf("LogLevel = %q, want info", c.LogLevel)
	}
}

func TestLoadOverrides(t *testing.T) {
	env := map[string]string{
		"GF_REST_ADDR":    ":9000",
		"GF_LLM_BASE_URL": "http://ollama:11434/v1",
	}
	c := Load(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if c.RESTAddr != ":9000" {
		t.Errorf("RESTAddr = %q, want :9000", c.RESTAddr)
	}
	if c.LLMBaseURL != "http://ollama:11434/v1" {
		t.Errorf("LLMBaseURL = %q", c.LLMBaseURL)
	}
}

func TestLoadLLMFormatDefault(t *testing.T) {
	c := Load(func(string) (string, bool) { return "", false })
	if c.LLMFormat != "chat_instruct" {
		t.Errorf("LLMFormat = %q, want chat_instruct", c.LLMFormat)
	}
}

func TestFastPathDefaults(t *testing.T) {
	c := Load(func(string) (string, bool) { return "", false })
	if c.GECToRModelDir != "/models/gector" {
		t.Errorf("GECToRModelDir = %q", c.GECToRModelDir)
	}
	if !c.HarperEnabled {
		t.Error("HarperEnabled should default true")
	}
	if c.EscalateMinConfidence <= 0 || c.EscalateMaxSentenceLen <= 0 {
		t.Error("escalation thresholds should have positive defaults")
	}
}

func TestLoad_LLMDefaultsAreLlamaCppGemma(t *testing.T) {
	cfg := Load(func(string) (string, bool) { return "", false })
	require.Equal(t, "http://llamacpp:8000/v1", cfg.LLMBaseURL)
	require.Equal(t, "gemma-4-E4B-it-qat-Q4_K_XL", cfg.LLMModel)
	require.Equal(t, "chat_instruct", cfg.LLMFormat)
}

func TestLoad_EscalateOnFastEditDefaultsTrue(t *testing.T) {
	// Default ON: the spike showed Harper's fixed 0.95 confidence was letting
	// confident-but-wrong edits bypass the confidence-floor escalation. With
	// EscalateOnFastEdit defaulting true the LLM (on the original) arbitrates.
	// Set GF_ESCALATE_ON_FAST_EDIT=false to opt out.
	cfg := Load(func(string) (string, bool) { return "", false })
	require.True(t, cfg.EscalateOnFastEdit)
}

func TestLoad_EscalateOnFastEditCanDisable(t *testing.T) {
	cfg := Load(func(k string) (string, bool) {
		if k == "GF_ESCALATE_ON_FAST_EDIT" {
			return "false", true
		}
		return "", false
	})
	require.False(t, cfg.EscalateOnFastEdit)
}

func TestLoad_PersonalizationDefaults(t *testing.T) {
	cfg := Load(func(string) (string, bool) { return "", false })
	require.True(t, cfg.PersonalizationEnabled,
		"PersonalizationEnabled should default true")
	require.Equal(t, 5*time.Minute, cfg.PersonalizationTTL,
		"PersonalizationTTL should default 5m")
}

func TestLoad_PersonalizationDisabledByEnv(t *testing.T) {
	cfg := Load(func(k string) (string, bool) {
		if k == "GF_PERSONALIZATION_ENABLED" {
			return "false", true
		}
		return "", false
	})
	require.False(t, cfg.PersonalizationEnabled)
}

func TestLoad_PersonalizationTTLOverride(t *testing.T) {
	cfg := Load(func(k string) (string, bool) {
		if k == "GF_PERSONALIZATION_TTL" {
			return "30s", true
		}
		return "", false
	})
	require.Equal(t, 30*time.Second, cfg.PersonalizationTTL)
}

func TestLoad_PersonalizationTTLInvalidFallsBackToDefault(t *testing.T) {
	cfg := Load(func(k string) (string, bool) {
		if k == "GF_PERSONALIZATION_TTL" {
			return "not-a-duration", true
		}
		return "", false
	})
	require.Equal(t, 5*time.Minute, cfg.PersonalizationTTL,
		"invalid TTL strings must fall back to the default, not zero or panic")
}

func TestLoad_HarperRuleConfigDefaults(t *testing.T) {
	cfg := Load(func(string) (string, bool) { return "", false })
	require.Equal(t, "american", cfg.HarperDialect)
	require.Nil(t, cfg.HarperDisabledRules)
	require.Nil(t, cfg.HarperEnabledRules)
	require.Equal(t, 0, cfg.HarperMaxInputLen)
}

func TestLoad_HarperRuleConfigOverrides(t *testing.T) {
	env := map[string]string{
		"GF_HARPER_DIALECT":        "british",
		"GF_HARPER_DISABLED_RULES": "A, B ,,C",
		"GF_HARPER_ENABLED_RULES":  " SpellCheck ",
		"GF_HARPER_MAX_INPUT_LEN":  "2048",
	}
	cfg := Load(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	require.Equal(t, "british", cfg.HarperDialect)
	require.Equal(t, []string{"A", "B", "C"}, cfg.HarperDisabledRules,
		"getCSV must split on comma, trim, and drop empties")
	require.Equal(t, []string{"SpellCheck"}, cfg.HarperEnabledRules)
	require.Equal(t, 2048, cfg.HarperMaxInputLen)
}

func TestLoad_HarperDisabledRulesEmptyStringIsNil(t *testing.T) {
	cfg := Load(func(k string) (string, bool) {
		if k == "GF_HARPER_DISABLED_RULES" {
			return "", true // present but empty -> nil, not []string{""}
		}
		return "", false
	})
	require.Nil(t, cfg.HarperDisabledRules)
}

func TestLoad_HarperUserDictDefault(t *testing.T) {
	cfg := Load(func(string) (string, bool) { return "", false })
	require.Equal(t, "/data/user-dict.txt", cfg.HarperUserDictPath,
		"HarperUserDictPath should default to /data/user-dict.txt so the bridge always has a user-dictionary file to watch")
}

func TestLoad_HarperUserDictOverride(t *testing.T) {
	cfg := Load(func(k string) (string, bool) {
		if k == "GF_HARPER_USER_DICT" {
			return "data/user_dictionary.txt", true
		}
		return "", false
	})
	require.Equal(t, "data/user_dictionary.txt", cfg.HarperUserDictPath)
}

func TestLoad_LLMSeedDefaultZero(t *testing.T) {
	cfg := Load(func(string) (string, bool) { return "", false })
	require.Equal(t, 0, cfg.LLMSeed, "LLMSeed must default to 0 when GF_LLM_SEED is unset")
}

func TestLoad_LLMSeedOverride(t *testing.T) {
	env := map[string]string{"GF_LLM_SEED": "123"}
	cfg := Load(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	require.Equal(t, 123, cfg.LLMSeed)
}

func TestLoadRephraseBackend(t *testing.T) {
	c := Load(func(string) (string, bool) { return "", false })
	require.Equal(t, "", c.RephraseProvider) // default: use the main LLM
	env := map[string]string{
		"GF_REPHRASE_PROVIDER": "anthropic",
		"GF_REPHRASE_BASE_URL": "https://api.anthropic.com",
		"GF_REPHRASE_MODEL":    "claude-x",
		"GF_REPHRASE_API_KEY":  "secret",
	}
	c2 := Load(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	require.Equal(t, "anthropic", c2.RephraseProvider)
	require.Equal(t, "https://api.anthropic.com", c2.RephraseBaseURL)
	require.Equal(t, "claude-x", c2.RephraseModel)
	require.Equal(t, "secret", c2.RephraseAPIKey)
}

func TestLoad_RetentionDaysDefaults90(t *testing.T) {
	cfg := Load(func(string) (string, bool) { return "", false })
	require.Equal(t, 90, cfg.RetentionDays,
		"RetentionDays should default to 90 days when GF_RETENTION_DAYS is unset")
}

func TestLoad_RetentionDaysOverride(t *testing.T) {
	cfg := Load(func(k string) (string, bool) {
		if k == "GF_RETENTION_DAYS" {
			return "30", true
		}
		return "", false
	})
	require.Equal(t, 30, cfg.RetentionDays)
}

func TestLoad_RetentionDaysZeroDisablesPruning(t *testing.T) {
	cfg := Load(func(k string) (string, bool) {
		if k == "GF_RETENTION_DAYS" {
			return "0", true
		}
		return "", false
	})
	require.Equal(t, 0, cfg.RetentionDays,
		"GF_RETENTION_DAYS=0 must disable pruning, not keep the 90-day default")
}

func TestLoad_SentenceCacheSizeDefaults2048(t *testing.T) {
	cfg := Load(func(string) (string, bool) { return "", false })
	require.Equal(t, 2048, cfg.SentenceCacheSize,
		"SentenceCacheSize should default to 2048 entries when GF_SENTENCE_CACHE_SIZE is unset")
}

func TestLoad_SentenceCacheSizeOverride(t *testing.T) {
	cfg := Load(func(k string) (string, bool) {
		if k == "GF_SENTENCE_CACHE_SIZE" {
			return "512", true
		}
		return "", false
	})
	require.Equal(t, 512, cfg.SentenceCacheSize)
}

func TestLoad_SentenceCacheSizeZeroDisables(t *testing.T) {
	cfg := Load(func(k string) (string, bool) {
		if k == "GF_SENTENCE_CACHE_SIZE" {
			return "0", true
		}
		return "", false
	})
	require.Equal(t, 0, cfg.SentenceCacheSize,
		"GF_SENTENCE_CACHE_SIZE=0 must disable the sentence pipeline, not keep the 2048 default")
}

func TestLoad_SkipLLMForSpellingOnlyDefaultFalse(t *testing.T) {
	cfg := Load(func(string) (string, bool) { return "", false })
	require.False(t, cfg.SkipLLMForSpellingOnly)
}

func TestLoad_SkipLLMForSpellingOnlyOverride(t *testing.T) {
	cfg := Load(func(k string) (string, bool) {
		if k == "GF_SKIP_LLM_FOR_SPELLING_ONLY" {
			return "true", true
		}
		return "", false
	})
	require.True(t, cfg.SkipLLMForSpellingOnly)
}

func TestOverEditFilterDefaultsTrueAndCanBeDisabled(t *testing.T) {
	empty := func(string) (string, bool) { return "", false }
	require.True(t, Load(empty).OverEditFilterEnabled, "default must be enabled")

	off := func(k string) (string, bool) {
		if k == "GF_OVEREDIT_FILTER" {
			return "false", true
		}
		return "", false
	}
	require.False(t, Load(off).OverEditFilterEnabled)
}

func TestArticleFixDefaultsTrueAndCanBeDisabled(t *testing.T) {
	empty := func(string) (string, bool) { return "", false }
	require.True(t, Load(empty).ArticleFixEnabled, "GF_ARTICLE_FIX must default to true")

	off := func(k string) (string, bool) {
		if k == "GF_ARTICLE_FIX" {
			return "false", true
		}
		return "", false
	}
	require.False(t, Load(off).ArticleFixEnabled)
}

func TestMergeFastEditsDefaultsOffAndReadsEnv(t *testing.T) {
	empty := func(string) (string, bool) { return "", false }
	require.Equal(t, "", Load(empty).MergeFastEditsMode, "default must be replace semantics")

	gector := func(k string) (string, bool) {
		if k == "GF_MERGE_FAST_EDITS" {
			return "gector", true
		}
		return "", false
	}
	require.Equal(t, "gector", Load(gector).MergeFastEditsMode)
}

// GF_FAST_HINTS (default off) threads Harper's SPELLING candidates into the
// escalation LLM as arbitration hints. Keep/revert is gated on the full cold
// golden eval — see the spike plan in
// .opencode/plans/2026-06-10-spike-fast-hint-prompt-injection.md. Default
// must be false so the existing eval baseline is unchanged until the
// operator opts in.
func TestFastHintsDefaultsOffAndReadsEnv(t *testing.T) {
	empty := func(string) (string, bool) { return "", false }
	require.False(t, Load(empty).FastHintsEnabled, "default must be off")

	on := func(k string) (string, bool) {
		if k == "GF_FAST_HINTS" {
			return "true", true
		}
		return "", false
	}
	require.True(t, Load(on).FastHintsEnabled)

	off := func(k string) (string, bool) {
		if k == "GF_FAST_HINTS" {
			return "false", true
		}
		return "", false
	}
	require.False(t, Load(off).FastHintsEnabled,
		"GF_FAST_HINTS=false must explicitly disable, not fall through to the default")
}

func TestLoadCompleteConfig(t *testing.T) {
	// defaults: off
	c := Load(func(string) (string, bool) { return "", false })
	require.False(t, c.CompleteEnabled, "GF_COMPLETE_ENABLED must default to false")

	env := map[string]string{
		"GF_COMPLETE_ENABLED": "true",
	}
	c2 := Load(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	require.True(t, c2.CompleteEnabled)
}

func TestLoadToneConfig(t *testing.T) {
	// defaults
	c := Load(func(string) (string, bool) { return "", false })
	require.Equal(t, "", c.ToneProvider)
	require.False(t, c.ToneEnabled)
	require.Equal(t, 80, c.ToneMinChars)
	require.Equal(t, 512, c.ToneCacheSize)

	env := map[string]string{
		"GF_TONE_PROVIDER":   "anthropic",
		"GF_TONE_BASE_URL":   "https://api.deepseek.com/anthropic",
		"GF_TONE_MODEL":      "deepseek-v4-flash",
		"GF_TONE_API_KEY":    "secret",
		"GF_TONE_ENABLED":    "true",
		"GF_TONE_MIN_CHARS":  "40",
		"GF_TONE_CACHE_SIZE": "1024",
	}
	c2 := Load(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	require.Equal(t, "anthropic", c2.ToneProvider)
	require.Equal(t, "https://api.deepseek.com/anthropic", c2.ToneBaseURL)
	require.Equal(t, "deepseek-v4-flash", c2.ToneModel)
	require.Equal(t, "secret", c2.ToneAPIKey)
	require.True(t, c2.ToneEnabled)
	require.Equal(t, 40, c2.ToneMinChars)
	require.Equal(t, 1024, c2.ToneCacheSize)
}

func TestLoad_SemanticVerifierDefaults(t *testing.T) {
	// Config discipline: every new GF_* gate defaults to the legacy behaviour
	// (verifier OFF) so existing deploys are byte-identical until the operator
	// opts in. Enabling is an eval-gated operator action (full cold golden +
	// clean-text FP, both at or below baseline).
	cfg := Load(func(string) (string, bool) { return "", false })
	require.False(t, cfg.SemanticVerifierEnabled,
		"GF_SEMANTIC_VERIFIER must default false")
	require.Equal(t, 0.80, cfg.SemanticVerifierThreshold,
		"GF_SEMANTIC_VERIFIER_THRESHOLD must default 0.80")
	require.Equal(t, "/models/minilm", cfg.SemanticVerifierModelPath,
		"GF_SEMANTIC_VERIFIER_MODEL_PATH must default /models/minilm")
}

func TestLoad_SemanticVerifierOverrides(t *testing.T) {
	env := map[string]string{
		"GF_SEMANTIC_VERIFIER":            "true",
		"GF_SEMANTIC_VERIFIER_THRESHOLD":  "0.65",
		"GF_SEMANTIC_VERIFIER_MODEL_PATH": "/opt/models/minilm",
	}
	cfg := Load(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	require.True(t, cfg.SemanticVerifierEnabled)
	require.InDelta(t, 0.65, cfg.SemanticVerifierThreshold, 1e-9)
	require.Equal(t, "/opt/models/minilm", cfg.SemanticVerifierModelPath)
}

// Phase-D reject suppression: byte-identical legacy behaviour by default
// (the suppressor is OFF). Operators enable it explicitly via
// GF_REJECT_SUPPRESSION after the Phase-D gates pass; the TTL bounds the
// stale-while-revalidate refresh cadence and is expressed in SECONDS
// (env-friendly integer) rather than the time.Duration string format used
// elsewhere — the "_SECONDS" suffix signals the unit.
func TestLoad_RejectSuppressionDefaults(t *testing.T) {
	cfg := Load(func(string) (string, bool) { return "", false })
	require.False(t, cfg.RejectSuppressionEnabled,
		"GF_REJECT_SUPPRESSION must default false")
	require.Equal(t, 300*time.Second, cfg.RejectSuppressionTTL,
		"GF_REJECT_SUPPRESSION_TTL_SECONDS must default 300 seconds")
}

func TestLoad_RejectSuppressionOverrides(t *testing.T) {
	env := map[string]string{
		"GF_REJECT_SUPPRESSION":             "true",
		"GF_REJECT_SUPPRESSION_TTL_SECONDS": "60",
	}
	cfg := Load(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	require.True(t, cfg.RejectSuppressionEnabled)
	require.Equal(t, 60*time.Second, cfg.RejectSuppressionTTL,
		"GF_REJECT_SUPPRESSION_TTL_SECONDS=60 must parse to 60s, not 60ns")
}

// Phase-E dialect spelling guard: the deterministic US->GB revert
// (correction.NewDialectSpellingRepair over the embedded VarCon lexicon)
// is OFF by default. Enable is an eval-gated operator action after the
// Phase-E gates pass (full cold golden + clean-text FP at or below
// baseline). The British-only-by-default semantics live in the wiring
// (main.go): the flag is ignored on non-British deploys, so American
// deploys never pay the construction cost — see main.go for the
// conditional that gates both the LLM rebuild and the 316KB embed parse.
// Config discipline is exception-free: every new GF_* gate defaults to
// the legacy behaviour so existing deploys are byte-identical until the
// operator opts in.
func TestLoad_DialectSpellingGuardDefaultsFalse(t *testing.T) {
	cfg := Load(func(string) (string, bool) { return "", false })
	require.False(t, cfg.DialectSpellingGuard,
		"GF_DIALECT_SPELLING_GUARD must default false")
}

func TestLoad_DialectSpellingGuardOverrides(t *testing.T) {
	t.Run("true", func(t *testing.T) {
		cfg := Load(func(k string) (string, bool) {
			if k == "GF_DIALECT_SPELLING_GUARD" {
				return "true", true
			}
			return "", false
		})
		require.True(t, cfg.DialectSpellingGuard,
			"GF_DIALECT_SPELLING_GUARD=true must enable the guard")
	})
	t.Run("false", func(t *testing.T) {
		cfg := Load(func(k string) (string, bool) {
			if k == "GF_DIALECT_SPELLING_GUARD" {
				return "false", true
			}
			return "", false
		})
		require.False(t, cfg.DialectSpellingGuard,
			"GF_DIALECT_SPELLING_GUARD=false must explicitly disable, not fall through to the default")
	})
	t.Run("1", func(t *testing.T) {
		cfg := Load(func(k string) (string, bool) {
			if k == "GF_DIALECT_SPELLING_GUARD" {
				return "1", true
			}
			return "", false
		})
		require.True(t, cfg.DialectSpellingGuard,
			"GF_DIALECT_SPELLING_GUARD=1 must parse as true (getBool convention)")
	})
}
