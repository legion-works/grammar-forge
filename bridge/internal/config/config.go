// Package config loads bridge configuration from the environment. Secrets
// (e.g. LLMAPIKey) come only from env — never hardcoded, never logged.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/grammarforge/bridge/internal/correction"
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
	// CompleteEnabled gates the /complete endpoint (default false — no accidental
	// paid calls until the clients ship; enable explicitly in the deploy compose).
	CompleteEnabled bool
	// CompleteCacheSize is the LRU capacity for the per-source+text completion
	// cache (0 disables; default 512). Completion has no fast path, so the cache
	// is the only way to elide repeated LLM calls for an identical prompt.
	CompleteCacheSize int
	// CompleteTemperature is the sampling temperature for completion (default
	// 0.4). Unlike correction/rephrase/tone (greedy, temperature 0), a non-zero
	// completion temperature makes continuations vary across different inputs
	// instead of collapsing to one canonical output. A per-request `temperature`
	// field overrides this. The fixed seed keeps it stable PER input.
	CompleteTemperature float64
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
	HarperUserDictPath string
	// EscalateMinConfidence is the fast-path→LLM escalation threshold
	// (correction.EscalationPolicy.MinConfidence): escalate to the LLM if the
	// best GECToR confidence is below this. Unrelated to the client-side
	// "high-confidence" UI cutoffs (e.g. clients/browser/src/overlay/popover-helpers.ts
	// CONFIDENCE_THRESHOLDS) — different scale, different purpose.
	EscalateMinConfidence float64
	// EscalateMaxSentenceLen escalates if input is longer than this (chars).
	EscalateMaxSentenceLen int
	// EscalateMinWords escalates empty-fast-path input with >= this many words.
	EscalateMinWords int
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

	// SemanticVerifier (Phase C): an all-MiniLM-L6-v2 embedding gate that
	// discards LLM rewrites whose cosine similarity to the original falls
	// below the threshold. Off by default — enabling is an eval-gated
	// operator action (full cold golden + clean-text FP at or below
	// baseline). A nil verifier or non-positive threshold is a no-op in the
	// service layer (fails OPEN).
	SemanticVerifierEnabled   bool    // GF_SEMANTIC_VERIFIER            (default false)
	SemanticVerifierThreshold float64 // GF_SEMANTIC_VERIFIER_THRESHOLD  (default 0.80)
	SemanticVerifierModelPath string  // GF_SEMANTIC_VERIFIER_MODEL_PATH (default /models/minilm)

	// RejectSuppression (Phase D): a TTL-cached, stale-while-revalidate
	// filter (correction.RejectSuppressor) that deterministically drops
	// suggestions matching the user's rejected personalization pairs. It
	// hardens the prompt-level "Do NOT change X" lines against LLM
	// non-compliance: if the user has rejected "setup"->"set up" three
	// or more times, the suggestion is dropped at finalize regardless of
	// what the LLM produces. Default OFF — enabling is an eval-gated
	// operator action after the Phase-D gates pass (full cold golden +
	// clean-text FP at or below baseline). The TTL bounds how often the
	// suppressor reads fresh rejection pairs from the store (the request
	// path never blocks); default 300s.
	RejectSuppressionEnabled bool          // GF_REJECT_SUPPRESSION             (default false)
	RejectSuppressionTTL     time.Duration // GF_REJECT_SUPPRESSION_TTL_SECONDS (default 300 seconds)

	// DialectSpellingGuard (Phase E): appends a deterministic
	// correction.NewDialectSpellingRepair rule to the LLM over-edit
	// repair chain, restoring the user's British spelling when the LLM
	// Americanized a word the user wrote in dialect form (color ->
	// colour, theater -> theatre, etc.). The rule reads from an embedded
	// VarCon-derived lexicon in correction.BritishLexicon(); the wiring
	// in main.go gates the rule's CONSTRUCTION on
	// (DialectSpellingGuard && HarperDialect == "british"), so American
	// deploys never pay the 316KB embed parse cost. Default OFF — v1
	// only ships the British direction (the lexicon currently contains
	// only ->British pairs); enabling on non-British deploys is a
	// no-op. Enabling is an eval-gated operator action after the
	// Phase-E gates pass (full cold golden 125/125 + clean-text FP
	// rate at or below Phase-A baseline for the british register).
	DialectSpellingGuard bool // GF_DIALECT_SPELLING_GUARD (default false)

	// Phase-B trusted-category escalation routing: comma-separated list of
	// fast-path categories the bridge may serve directly without consulting
	// the LLM (correction.EscalationPolicy.TrustedCategories). Default ""
	// preserves the legacy SkipLLMForSpellingOnly semantics — enablement
	// is an eval-gated operator action (Phase-A per-category FP attribution
	// motivates the candidate set; BOTH run_eval.py --require-exact 125/125
	// AND clean_eval.py fp_rate ≤ baseline must pass before a candidate set
	// goes live on a deploy). Raw CSV; main.go calls ParseTrustedCategories
	// to validate. The routing field is []string; the env-var-on-the-wire
	// form is CSV because comma lists are the convention for GF_*_RULES
	// (HarperDisabledRules, HarperEnabledRules) and similar.
	EscalationTrustedCategories string // GF_ESCALATION_TRUSTED_CATEGORIES (default "")
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

		ToneProvider:        get("GF_TONE_PROVIDER", ""),
		ToneBaseURL:         get("GF_TONE_BASE_URL", ""),
		ToneModel:           get("GF_TONE_MODEL", ""),
		ToneAPIKey:          get("GF_TONE_API_KEY", ""),
		ToneEnabled:         getBool("GF_TONE_ENABLED", false),
		ToneMinChars:        getInt("GF_TONE_MIN_CHARS", 80),
		CompleteEnabled:     getBool("GF_COMPLETE_ENABLED", false),
		CompleteCacheSize:   getInt("GF_COMPLETE_CACHE_SIZE", 512),
		CompleteTemperature: getFloat("GF_COMPLETE_TEMPERATURE", 0.4),
		ToneCacheSize:       getInt("GF_TONE_CACHE_SIZE", 512),

		GECToRModelDir:            get("GF_GECTOR_MODEL_DIR", "/models/gector"),
		HarperEnabled:             getBool("GF_HARPER_ENABLED", true),
		HarperMarkdown:            getBool("GF_HARPER_MARKDOWN", true),
		HarperIgnoreLinkTitle:     getBool("GF_HARPER_IGNORE_LINK_TITLE", false),
		HarperDialect:             get("GF_HARPER_DIALECT", "american"),
		HarperDisabledRules:       getCSV("GF_HARPER_DISABLED_RULES"),
		HarperEnabledRules:        getCSV("GF_HARPER_ENABLED_RULES"),
		HarperMaxInputLen:         getInt("GF_HARPER_MAX_INPUT_LEN", 0),
		HarperUserDictPath:        get("GF_HARPER_USER_DICT", "/data/user-dict.txt"),
		EscalateMinConfidence:     getFloat("GF_ESCALATE_MIN_CONFIDENCE", 0.7),
		EscalateMaxSentenceLen:    getInt("GF_ESCALATE_MAX_SENTENCE_LEN", 200),
		EscalateMinWords:          getInt("GF_ESCALATE_MIN_WORDS", 3),
		EscalateOnFastEdit:        getBool("GF_ESCALATE_ON_FAST_EDIT", true),
		SkipLLMForSpellingOnly:    getBool("GF_SKIP_LLM_FOR_SPELLING_ONLY", false),
		MergeFastEditsMode:        get("GF_MERGE_FAST_EDITS", ""),
		OverEditFilterEnabled:     getBool("GF_OVEREDIT_FILTER", true),
		ArticleFixEnabled:         getBool("GF_ARTICLE_FIX", true),
		IrregularPluralFixEnabled: getBool("GF_IRREGULAR_PLURAL_FIX", true),
		CapitalizationFixEnabled:  getBool("GF_CAPITALIZATION_FIX", true),
		FastHintsEnabled:          getBool("GF_FAST_HINTS", false),

		PersonalizationEnabled: getBool("GF_PERSONALIZATION_ENABLED", true),
		PersonalizationTTL:     getDuration("GF_PERSONALIZATION_TTL", 5*time.Minute),

		RetentionDays: getInt("GF_RETENTION_DAYS", 90),

		SentenceCacheSize: getInt("GF_SENTENCE_CACHE_SIZE", 2048),

		SynonymsEnabled: getBool("GF_SYNONYMS_ENABLED", true),
		ThesaurusPath:   get("GF_THESAURUS_PATH", "/data/mthesaur.txt"),

		SemanticVerifierEnabled:   getBool("GF_SEMANTIC_VERIFIER", false),
		SemanticVerifierThreshold: getFloat("GF_SEMANTIC_VERIFIER_THRESHOLD", 0.80),
		SemanticVerifierModelPath: get("GF_SEMANTIC_VERIFIER_MODEL_PATH", "/models/minilm"),

		RejectSuppressionEnabled: getBool("GF_REJECT_SUPPRESSION", false),
		RejectSuppressionTTL:     time.Duration(getInt("GF_REJECT_SUPPRESSION_TTL_SECONDS", 300)) * time.Second,

		DialectSpellingGuard: getBool("GF_DIALECT_SPELLING_GUARD", false),

		EscalationTrustedCategories: get("GF_ESCALATION_TRUSTED_CATEGORIES", ""),
	}
}

// ParseTrustedCategories parses the GF_ESCALATION_TRUSTED_CATEGORIES CSV
// into a validated []string. Tokens are trimmed and lowercased; any invalid
// token (empty, literal "grammar", or unknown) makes the WHOLE variable
// rejected — callers MUST treat the error as "ignore the variable, fall back
// to the legacy empty trust set". A partial success on a typo'd CSV would be
// a routing foot-gun: the operator typed "spelling,typo" expecting spelling,
// the parser silently accepts spelling, and the deploy's behaviour diverges
// from intent in a hard-to-diagnose way. Source of truth for the trustable
// set is correction.IsTrustableCategory.
//
// Exported because main.go is the consumer; unexported callers would push
// the parse-time validation out of testability. The function has no
// additional state and is safe to call from any goroutine at startup.
func ParseTrustedCategories(csv string) ([]string, error) {
	if csv == "" {
		return nil, nil
	}
	var out []string
	for _, raw := range strings.Split(csv, ",") {
		tok := strings.ToLower(strings.TrimSpace(raw))
		if tok == "" {
			return nil, fmt.Errorf("GF_ESCALATION_TRUSTED_CATEGORIES: empty token (consecutive commas or trailing comma)")
		}
		if tok == "grammar" {
			// Reject the LITERAL "grammar" even though CategoryGrammar is the
			// empty string: a typed "grammar" is unambiguously an attempt to
			// trust grammar and must surface as a diagnostic, not a no-op.
			return nil, fmt.Errorf("GF_ESCALATION_TRUSTED_CATEGORIES: 'grammar' is never trustable (LITERAL got %q)", tok)
		}
		if !correction.IsTrustableCategory(tok) {
			return nil, fmt.Errorf("GF_ESCALATION_TRUSTED_CATEGORIES: unknown category %q (valid: spelling, punctuation, typography, style)", tok)
		}
		out = append(out, tok)
	}
	return out, nil
}

// FromOS is the production loader.
func FromOS() Config { return Load(os.LookupEnv) }
