// Package config loads bridge configuration from the environment. Secrets
// (e.g. LLMAPIKey) come only from env — never hardcoded, never logged.
package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all bridge runtime settings.
type Config struct {
	RESTAddr   string
	GRPCAddr   string
	LLMBaseURL string
	LLMModel   string
	LLMFormat  string // "chat_instruct" (default) or "grmr_native"
	LLMAPIKey  string
	DBPath     string
	LogLevel   string

	// Fast path (Plan 1C): Harper + GECToR run in-process; the LLM is
	// escalation-only (see correction.EscalationPolicy).
	GECToRModelDir string
	HarperEnabled  bool
	// HarperMarkdown parses Harper input as Markdown so code spans, fenced code
	// blocks, math, and HTML are masked unlintable (default true). Set
	// GF_HARPER_MARKDOWN=false for plain-English parsing. HarperIgnoreLinkTitle
	// additionally masks Markdown link titles (default false).
	HarperMarkdown        bool
	HarperIgnoreLinkTitle bool
	// HarperDialect selects the curated-rule dialect:
	// american|british|canadian|australian|indian (default american). Unknown
	// values fall back to american.
	HarperDialect string
	// HarperDisabledRules / HarperEnabledRules force individual curated rules
	// off / on by their rule key (the linter struct name, e.g. "LongSentences",
	// "SpellCheck"), as comma-separated lists. Empty = no override (curated
	// defaults). Disabled is applied first, then Enabled.
	HarperDisabledRules []string
	HarperEnabledRules  []string
	// HarperMaxInputLen skips Harper entirely for inputs longer than this many
	// bytes (0 = no limit) to bound worst-case latency on pathological input.
	HarperMaxInputLen int
	// HarperUserDictPath points at a newline-delimited user word list stacked on
	// top of the curated dictionary (blank/'#' lines ignored). Empty = curated
	// only. The file is watched for changes and hot-reloaded. Holds user text:
	// keep it under data/ (gitignored).
	HarperUserDictPath     string
	EscalateMinConfidence  float64 // escalate to LLM if best GECToR confidence < this
	EscalateMaxSentenceLen int     // escalate if input longer than this (chars)
	EscalateMinWords       int     // escalate empty-fast-path input with >= this many words
	// EscalateOnFastEdit forces escalation whenever the fast path produced any
	// edit (see correction.EscalationPolicy.EscalateOnFastEdit). Defaults true;
	// the spike showed Harper's fixed 0.95 confidence was letting
	// confident-but-wrong edits bypass the confidence-floor escalation. The
	// LLM, fed the ORIGINAL text, can override any fast edit. Opt out with
	// GF_ESCALATE_ON_FAST_EDIT=false to restore the historical confidence-floor
	// behaviour.
	EscalateOnFastEdit bool

	// Phase-2 P4 prompt-cache personalisation. On by default. The cache is
	// TTL-bounded (no background goroutine) and the snapshot is read
	// synchronously by the prompt builder. Set GF_PERSONALIZATION_ENABLED=false
	// to disable (the prompt builder keeps using the base system prompt
	// byte-identical to today). The TTL bounds how often the store is
	// queried for fresh examples; default 5m. Invalid TTL strings fall back
	// to the default rather than zero or panicking.
	PersonalizationEnabled bool
	PersonalizationTTL     time.Duration
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
	getCSV := func(k string) []string {
		v, ok := getenv(k)
		if !ok || v == "" {
			return nil
		}
		var out []string
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		return out
	}
	getDuration := func(k string, def time.Duration) time.Duration {
		if v, ok := getenv(k); ok && v != "" {
			if d, err := time.ParseDuration(v); err == nil {
				return d
			}
		}
		return def
	}
	return Config{
		RESTAddr:   get("GF_REST_ADDR", ":8000"),
		GRPCAddr:   get("GF_GRPC_ADDR", ":8082"),
		LLMBaseURL: get("GF_LLM_BASE_URL", "http://llamacpp:8000/v1"),
		LLMModel:   get("GF_LLM_MODEL", "gemma-4-E4B-it-qat-Q4_K_XL"),
		LLMFormat:  get("GF_LLM_FORMAT", "chat_instruct"),
		LLMAPIKey:  get("GF_LLM_API_KEY", ""),
		DBPath:     get("GF_DB_PATH", "/data/corrections.db"),
		LogLevel:   get("GF_LOG_LEVEL", "info"),

		GECToRModelDir:         get("GF_GECTOR_MODEL_DIR", "/models/gector"),
		HarperEnabled:          getBool("GF_HARPER_ENABLED", true),
		HarperMarkdown:         getBool("GF_HARPER_MARKDOWN", true),
		HarperIgnoreLinkTitle:  getBool("GF_HARPER_IGNORE_LINK_TITLE", false),
		HarperDialect:          get("GF_HARPER_DIALECT", "american"),
		HarperDisabledRules:    getCSV("GF_HARPER_DISABLED_RULES"),
		HarperEnabledRules:     getCSV("GF_HARPER_ENABLED_RULES"),
		HarperMaxInputLen:      getInt("GF_HARPER_MAX_INPUT_LEN", 0),
		HarperUserDictPath:     get("GF_HARPER_USER_DICT", ""),
		EscalateMinConfidence:  getFloat("GF_ESCALATE_MIN_CONFIDENCE", 0.7),
		EscalateMaxSentenceLen: getInt("GF_ESCALATE_MAX_SENTENCE_LEN", 200),
		EscalateMinWords:       getInt("GF_ESCALATE_MIN_WORDS", 3),
		EscalateOnFastEdit:     getBool("GF_ESCALATE_ON_FAST_EDIT", true),

		PersonalizationEnabled: getBool("GF_PERSONALIZATION_ENABLED", true),
		PersonalizationTTL:     getDuration("GF_PERSONALIZATION_TTL", 5*time.Minute),
	}
}

// FromOS is the production loader.
func FromOS() Config { return Load(os.LookupEnv) }
