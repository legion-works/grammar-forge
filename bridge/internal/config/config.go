// Package config loads bridge configuration from the environment. Secrets
// (e.g. LLMAPIKey) come only from env — never hardcoded, never logged.
package config

import (
	"os"
	"strconv"
)

// Config holds all bridge runtime settings.
type Config struct {
	RESTAddr   string
	GRPCAddr   string
	LLMBaseURL string
	LLMModel   string
	LLMFormat  string // "grmr_native" (default) or "chat_instruct"
	LLMAPIKey  string
	DBPath     string
	LogLevel   string

	// Fast path (Plan 1C): Harper + GECToR run in-process; the LLM is
	// escalation-only (see correction.EscalationPolicy).
	GECToRModelDir         string
	HarperEnabled          bool
	EscalateMinConfidence  float64 // escalate to LLM if best GECToR confidence < this
	EscalateMaxSentenceLen int     // escalate if input longer than this (chars)
	EscalateMinWords       int     // escalate empty-fast-path input with >= this many words
}

// Getenv matches os.LookupEnv; injected for testability.
type Getenv func(key string) (string, bool)

// Load builds a Config from env, applying defaults. Pass os.LookupEnv in main.
func Load(getenv Getenv) Config {
	get := func(key, def string) string {
		if v, ok := getenv(key); ok && v != "" {
			return v
		}
		return def
	}
	getBool := func(k string, def bool) bool {
		if v, ok := getenv(k); ok {
			return v == "1" || v == "true" || v == "TRUE"
		}
		return def
	}
	getFloat := func(k string, def float64) float64 {
		if v, ok := getenv(k); ok {
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				return f
			}
		}
		return def
	}
	getInt := func(k string, def int) int {
		if v, ok := getenv(k); ok {
			if n, err := strconv.Atoi(v); err == nil {
				return n
			}
		}
		return def
	}
	return Config{
		RESTAddr:   get("GF_REST_ADDR", ":8000"),
		GRPCAddr:   get("GF_GRPC_ADDR", ":8082"),
		LLMBaseURL: get("GF_LLM_BASE_URL", "http://vllm:8000/v1"),
		LLMModel:   get("GF_LLM_MODEL", "qingy2024/GRMR-V3-Q4B"),
		LLMFormat:  get("GF_LLM_FORMAT", "grmr_native"),
		LLMAPIKey:  get("GF_LLM_API_KEY", ""),
		DBPath:     get("GF_DB_PATH", "/data/corrections.db"),
		LogLevel:   get("GF_LOG_LEVEL", "info"),

		GECToRModelDir:         get("GF_GECTOR_MODEL_DIR", "/models/gector"),
		HarperEnabled:          getBool("GF_HARPER_ENABLED", true),
		EscalateMinConfidence:  getFloat("GF_ESCALATE_MIN_CONFIDENCE", 0.7),
		EscalateMaxSentenceLen: getInt("GF_ESCALATE_MAX_SENTENCE_LEN", 200),
		EscalateMinWords:       getInt("GF_ESCALATE_MIN_WORDS", 3),
	}
}

// FromOS is the production loader.
func FromOS() Config { return Load(os.LookupEnv) }
