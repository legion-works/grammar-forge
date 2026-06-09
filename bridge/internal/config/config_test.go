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

func TestLoad_HarperUserDictDefaultEmpty(t *testing.T) {
	cfg := Load(func(string) (string, bool) { return "", false })
	require.Equal(t, "", cfg.HarperUserDictPath)
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
