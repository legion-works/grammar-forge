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
	// LLMSeed is the sampling seed sent to the LLM backend on every request so
	// greedy output is reproducible across runs (deterministic eval gating and
	// stable client output). Configurable via GF_LLM_SEED (default 0). Backends
	// that ignore seed (or run greedy) are unaffected; for BYO temp>0 configs it
	// pins sampling.
	LLMSeed   int
	LLMAPIKey string
	// Optional dedicated rephrase backend. When RephraseProvider is empty the
	// rephrase endpoint uses the default LLM (LLMBaseURL/LLMModel/LLMAPIKey).
	RephraseProvider string // "" | "openai" | "anthropic"
	RephraseBaseURL  string
	RephraseModel    string
	RephraseAPIKey   string // env only, never logged
	// Optional dedicated tone backend (GF_TONE_*). Empty Provider => fall back
	// to the rephrase backend, then the default LLM. Mirrors Rephrase*.
	ToneProvider string // "" | "openai" | "anthropic"
	ToneBaseURL  string
	ToneModel    string
	ToneAPIKey   string // env only, never logged
	// ToneEnabled gates the /tone endpoint (default false — no accidental paid
	// calls until the clients ship; enable explicitly in the deploy compose).
	ToneEnabled bool
	// ToneMinChars: field-granularity tone requests below this many bytes return
	// empty without calling the LLM (defense-in-depth; on-demand sentence
	// requests are exempt). 0 = no floor.
	ToneMinChars int
	// ToneCacheSize is the LRU capacity for the per-text-unit tone cache
	// (0 disables; default 512).
	ToneCacheSize int
	DBPath        string
	LogLevel      string

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
	// HarperUserDictPath points at a newline-delimited user word list stacked
	// on top of the curated dictionary (blank/'#' lines ignored). The file is
	// watched for changes and hot-reloaded; the same file is the allowlist
	// the correction service uses to suppress LLM re-flags. Defaults to
	// /data/user-dict.txt (always present, may be empty) so the bridge's
	// user-dictionary feature is on by default. Holds user text: keep it
	// under data/ (gitignored).
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
	// SkipLLMForSpellingOnly serves ALL-spelling fast-path results directly
	// instead of escalating to the LLM (see
	// correction.EscalationPolicy.SkipLLMForSpellingOnly). Defaults false;
	// opt in with GF_SKIP_LLM_FOR_SPELLING_ONLY=true.
	SkipLLMForSpellingOnly bool

	// MergeFastEditsMode selects the escalation result composition
	// (correction.MergeFastEdits*): "" (default) = legacy replace semantics
	// (the LLM diff is the whole escalation result); "gector" / "all" =
	// merge-not-replace SPIKE — fast edits that do not conflict with any
	// LLM edit are appended. MEASURED AND REJECTED 2026-06-10: golden
	// 125 -> 120 (gector) / 118 (all); see the verdict on
	// correction.Service.mergeFastEditsMode. "gector-word" / "all-word" =
	// word-granularity conflict variant (the LLM owns every word it
	// touched; insertions claim both flanking words) — fixes the
	// double-insertion kill class, not the LLM-silent-word classes.
	// Keep "" (default).
	MergeFastEditsMode string
	// FastHintsEnabled threads Harper's SPELLING candidates into the
	// escalation LLM as arbitration hints. Default false. The LLM, fed the
	// ORIGINAL text, can fix the flagged token in text space (and ignore
	// the hint on code/names/identifiers). Measured live miss: Harper
	// flags `sdasd`->`sad` (conf 0.95) but the LLM leaves the gibberish
	// token verbatim. Span-geometry merging was measured and REJECTED
	// (GF_MERGE_FAST_EDITS spike — clean-text FPs on code); this spike
	// instead lets the LLM arbitrate.
	//
	// MEASURED AND REJECTED (2026-06-10 full cold golden eval): 125/125 ->
	// 123/125 with hints on. The hints DO fix the gibberish-token miss,
	// but the appended block perturbs unrelated edits: a contraction
	// expanded ("Who's" -> "Who is") and a lie/lay fix the baseline catches
	// was masked. Keep false unless a narrower trigger is built;
	// re-enabling gates on the full cold eval. See
	// .opencode/specs/2026-06-10-fast-hint-spike.md.
	FastHintsEnabled bool
	// OverEditFilterEnabled wires the LLM over-edit repair chain
	// (correction.DefaultOverEditRules) that deterministically reverts
	// measured LLM over-edit classes — nor/or proximity-agreement flips and
	// proper-noun comma restructures (golden cases 118/91) — on the LLM
	// output before diffing. Default true; opt out with
	// GF_OVEREDIT_FILTER=false for byte-identical pre-filter behaviour.
	OverEditFilterEnabled bool
	// ArticleFixEnabled wires the deterministic a/an article repair
	// (correction.applyArticleFixes) applied to LLM output after the
	// over-edit chain and before diffing. Fixes silent-h words ("a
	// honest"→"an honest", "a hour"→"an hour", etc.) that Harper's
	// letter-based AnA rule misses. Default true; opt out with
	// GF_ARTICLE_FIX=false. The full cold golden eval is the FP gate before
	// expanding the silent-h stem list beyond v1's 5 unambiguous stems.
	ArticleFixEnabled bool
	// IrregularPluralFixEnabled wires the Harper irregular-plural possessive
	// misfire repair (correction.repairIrregularPluralPossessive) applied to
	// Harper fast-path suggestions before merging. Replaces confident-wrong
	// possessive suggestions (tooths→tooth's, womans→woman's,
	// luggages→luggage's) with the correct plural (teeth, women, luggage).
	// Default true; opt out with GF_IRREGULAR_PLURAL_FIX=false.
	IrregularPluralFixEnabled bool
	// CapitalizationFixEnabled wires the Harper mid-sentence capitalization
	// misfire filter (correction.dropMidSentenceCapitalization) applied to
	// fast-path suggestions per-corrector. Drops capitalization-only edits
	// of unambiguous function words (e.g. on→On, he→He) at non-sentence-start
	// positions. Proper nouns (taipei→Taipei), "i"→"I", and true
	// sentence-start capitalizations are always preserved. Default true;
	// opt out with GF_CAPITALIZATION_FIX=false.
	CapitalizationFixEnabled bool

	// Phase-2 P4 prompt-cache personalisation. On by default. The cache is
	// TTL-bounded (no background goroutine) and the snapshot is read
	// synchronously by the prompt builder. Set GF_PERSONALIZATION_ENABLED=false
	// to disable (the prompt builder keeps using the base system prompt
	// byte-identical to today). The TTL bounds how often the store is
	// queried for fresh examples; default 5m. Invalid TTL strings fall back
	// to the default rather than zero or panicking.
	PersonalizationEnabled bool
	PersonalizationTTL     time.Duration

	// RetentionDays prunes unsignaled correction rows older than this many
	// days at startup (0 = keep forever). Default 90.
	RetentionDays int

	// SentenceCacheSize enables the per-sentence pipeline with an LRU of
	// this many sentence entries (0 disables; default 2048). With a non-zero
	// size the service segments multi-sentence input, checks each sentence
	// independently, and serves unchanged sentences from the cache, collapsing
	// steady-state typing latency to ~one sentence's cost.
	SentenceCacheSize int

	// SynonymsEnabled gates the /synonyms payload (default true). The route
	// is always on the wire regardless — disabled just means the response
	// is `{word, synonyms:[]}`. Matches the SPEC §1 "informational endpoint
	// on by default" posture so a misconfigured deploy never hides the
	// route from clients.
	SynonymsEnabled bool
	// ThesaurusPath is the on-disk path to the Moby Thesaurus II dataset
	// (fetched at deploy via bridge/scripts/fetch-thesaurus.sh, gitignored).
	// The file is read once at startup; a missing file is a no-op, not an
	// error — the bridge still boots and /synonyms returns empty.
	ThesaurusPath string
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
		LLMSeed:    getInt("GF_LLM_SEED", 0),
		LLMAPIKey:  get("GF_LLM_API_KEY", ""),
		DBPath:     get("GF_DB_PATH", "/data/corrections.db"),
		LogLevel:   get("GF_LOG_LEVEL", "info"),

		RephraseProvider: get("GF_REPHRASE_PROVIDER", ""),
		RephraseBaseURL:  get("GF_REPHRASE_BASE_URL", ""),
		RephraseModel:    get("GF_REPHRASE_MODEL", ""),
		RephraseAPIKey:   get("GF_REPHRASE_API_KEY", ""),

		ToneProvider:  get("GF_TONE_PROVIDER", ""),
		ToneBaseURL:   get("GF_TONE_BASE_URL", ""),
		ToneModel:     get("GF_TONE_MODEL", ""),
		ToneAPIKey:    get("GF_TONE_API_KEY", ""),
		ToneEnabled:   getBool("GF_TONE_ENABLED", false),
		ToneMinChars:  getInt("GF_TONE_MIN_CHARS", 80),
		ToneCacheSize: getInt("GF_TONE_CACHE_SIZE", 512),

		GECToRModelDir:         get("GF_GECTOR_MODEL_DIR", "/models/gector"),
		HarperEnabled:          getBool("GF_HARPER_ENABLED", true),
		HarperMarkdown:         getBool("GF_HARPER_MARKDOWN", true),
		HarperIgnoreLinkTitle:  getBool("GF_HARPER_IGNORE_LINK_TITLE", false),
		HarperDialect:          get("GF_HARPER_DIALECT", "american"),
		HarperDisabledRules:    getCSV("GF_HARPER_DISABLED_RULES"),
		HarperEnabledRules:     getCSV("GF_HARPER_ENABLED_RULES"),
		HarperMaxInputLen:      getInt("GF_HARPER_MAX_INPUT_LEN", 0),
		HarperUserDictPath:     get("GF_HARPER_USER_DICT", "/data/user-dict.txt"),
		EscalateMinConfidence:  getFloat("GF_ESCALATE_MIN_CONFIDENCE", 0.7),
		EscalateMaxSentenceLen: getInt("GF_ESCALATE_MAX_SENTENCE_LEN", 200),
		EscalateMinWords:       getInt("GF_ESCALATE_MIN_WORDS", 3),
		EscalateOnFastEdit:     getBool("GF_ESCALATE_ON_FAST_EDIT", true),
		SkipLLMForSpellingOnly: getBool("GF_SKIP_LLM_FOR_SPELLING_ONLY", false),
		MergeFastEditsMode:     get("GF_MERGE_FAST_EDITS", ""),
		OverEditFilterEnabled:      getBool("GF_OVEREDIT_FILTER", true),
		ArticleFixEnabled:          getBool("GF_ARTICLE_FIX", true),
		IrregularPluralFixEnabled:  getBool("GF_IRREGULAR_PLURAL_FIX", true),
		CapitalizationFixEnabled:   getBool("GF_CAPITALIZATION_FIX", true),
		FastHintsEnabled:           getBool("GF_FAST_HINTS", false),

		PersonalizationEnabled: getBool("GF_PERSONALIZATION_ENABLED", true),
		PersonalizationTTL:     getDuration("GF_PERSONALIZATION_TTL", 5*time.Minute),

		RetentionDays: getInt("GF_RETENTION_DAYS", 90),

		SentenceCacheSize: getInt("GF_SENTENCE_CACHE_SIZE", 2048),

		SynonymsEnabled: getBool("GF_SYNONYMS_ENABLED", true),
		ThesaurusPath:   get("GF_THESAURUS_PATH", "/data/mthesaur.txt"),
	}
}

// FromOS is the production loader.
func FromOS() Config { return Load(os.LookupEnv) }
