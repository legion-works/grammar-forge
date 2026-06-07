// Package config loads bridge configuration from the environment. Secrets
// (e.g. LLMAPIKey) come only from env — never hardcoded, never logged.
package config

import "os"

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
	return Config{
		RESTAddr:   get("GF_REST_ADDR", ":8000"),
		GRPCAddr:   get("GF_GRPC_ADDR", ":8082"),
		LLMBaseURL: get("GF_LLM_BASE_URL", "http://vllm:8000/v1"),
		LLMModel:   get("GF_LLM_MODEL", "qingy2024/GRMR-V3-Q4B"),
		LLMFormat:  get("GF_LLM_FORMAT", "grmr_native"),
		LLMAPIKey:  get("GF_LLM_API_KEY", ""),
		DBPath:     get("GF_DB_PATH", "/data/corrections.db"),
		LogLevel:   get("GF_LOG_LEVEL", "info"),
	}
}

// FromOS is the production loader.
func FromOS() Config { return Load(os.LookupEnv) }
