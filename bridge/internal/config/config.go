// Package config loads bridge configuration from the environment. Secrets
// (e.g. LLMAPIKey) come only from env — never hardcoded, never logged.
package config

import (
	"fmt"
	"log/slog"
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
	// LLM retry + circuit breaker (Phase 1b resilience quick-win). Applied to
	// EVERY llm.Client/llm.AnthropicClient the bridge constructs (default,
	// rephrase override, tone override) — main.go wires the same
	// RetryConfig/BreakerConfig into each. Defaults are conservative: retry
	// on (1 retry, 200-500ms jittered backoff — see llm.DefaultRetryConfig),
	// breaker on (5 consecutive failures opens it, 30s cooldown before a
	// half-open probe — see llm.DefaultBreakerConfig). A dead backend then
	// fails fast (breaker open) instead of every request stacking its own
	// 30s HTTP timeout one at a time.
	LLMRetryEnabled     bool          // GF_LLM_RETRY_ENABLED           (default true)
	LLMRetryMaxRetries  int           // GF_LLM_RETRY_MAX_RETRIES       (default 1)
	LLMRetryBaseDelay   time.Duration // GF_LLM_RETRY_BASE_DELAY        (default 200ms)
	LLMRetryMaxDelay    time.Duration // GF_LLM_RETRY_MAX_DELAY         (default 500ms)
	LLMBreakerEnabled   bool          // GF_LLM_BREAKER_ENABLED         (default true)
	LLMBreakerThreshold int           // GF_LLM_BREAKER_THRESHOLD       (default 5)
	LLMBreakerCooldown  time.Duration // GF_LLM_BREAKER_COOLDOWN        (default 30s)
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
	// GECToRPasses (Task 7, GF_GECTOR_PASSES) controls how many GECToR
	// inference passes gector.GECToR.Correct runs per request (default 1 =
	// today's single pass, byte-identical output — see gector.go's Correct
	// doc comment). Clamped to [1,3]: below 1 is nonsensical (there is
	// always at least one pass), and above 3 buys little extra recall for
	// roughly linear extra latency per pass while the confidence-calibration
	// bucket stays shared across passes (see gector.go), so an unbounded
	// value would let a typo'd deploy silently pay unbounded latency.
	// Load has no injected *slog.Logger, but log/slog's package-level
	// default logger is already used directly (without one being threaded
	// through) elsewhere in this bridge (main.go, fastpath_ort.go,
	// suppression.go, cache.go), so the clamp warning is emitted here via
	// slog.Warn rather than deferred to fastpath_ort.go, the sole consumer —
	// this also keeps the clamp behaviour unit-testable in config_test.go.
	GECToRPasses  int
	HarperEnabled bool
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
	// LLMSentenceContext (Task 6, GF_LLM_SENTENCE_CONTEXT) enables the ±1
	// sentence neighbor context sent alongside each sentence on the LLM
	// escalation prompt (see correction.Service.SetSentenceContext /
	// prompt.Builder.Build). Default false — a disabled flag leaves the
	// wire payload byte-identical to before this feature existed. Only
	// takes effect on the per-sentence pipeline (GF_SENTENCE_CACHE_SIZE >
	// 0 and multi-sentence input); the whole-text fallback never has a
	// neighbor sentence to send. PRIVACY: when enabled, each LLM request
	// also carries the neighboring sentences; with a REMOTE
	// GF_LLM_BASE_URL this sends more of a user's text off-host than the
	// bare sentence being checked.
	LLMSentenceContext bool
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

	// ConfidenceCalibration (Task 3): when true, main constructs a
	// correction.ConfidenceCalibrator over the store and wires it via
	// Service.SetConfidenceCalibrator. DISPLAY-ONLY: it changes the
	// `confidence` value clients see on /correct suggestions, replacing the
	// raw per-model constant with the observed (model, category) acceptance
	// rate; it never changes routing (escalation, suppression, or which
	// suggestions are returned) and never changes what is written to the
	// edits-table audit log, which always keeps the raw model confidence
	// (see correction.Service.SetConfidenceCalibrator). GF_ESCALATION_CALIBRATED
	// (EscalationCalibrated, below) additionally uses the SAME calibrator's
	// output to DRIVE escalation decisions — main.go constructs the
	// calibrator when EITHER flag is on, so enabling that flag alone (with
	// this one left false) still builds the calibrator, just without
	// touching the response JSON. Default false; enabling is an eval-gated
	// operator action, matching the other calibration-adjacent gates in
	// this file.
	ConfidenceCalibration bool // GF_CONFIDENCE_CALIBRATION    (default false)
	// CalibrationTTLSeconds bounds how often the calibrator re-reads
	// Store.SignalRates (stale-while-revalidate — the request path never
	// blocks on the store; see correction.ConfidenceCalibrator). Expressed
	// in SECONDS (env-friendly integer), mirroring
	// GF_REJECT_SUPPRESSION_TTL_SECONDS.
	CalibrationTTLSeconds int // GF_CALIBRATION_TTL_SECONDS   (default 300)
	// CalibrationMinSamples is the minimum Accepted+Rejected signal count a
	// (model, category) bucket needs before the calibrator trusts it; a
	// thinner bucket reports ok=false and the caller keeps the raw
	// confidence (see correction.ConfidenceCalibrator.Calibrated).
	CalibrationMinSamples int // GF_CALIBRATION_MIN_SAMPLES   (default 10)

	// EscalationCalibrated (Task 5): when true, main wires the SAME
	// ConfidenceCalibrator built for ConfidenceCalibration onto
	// correction.Service.SetEscalationCalibrator instead of (or in addition
	// to) SetConfidenceCalibrator. ROUTING, not display: a non-trusted,
	// non-grammar fast-path suggestion set that is calibrated-confident at
	// or above EscalationPolicy.MinConfidence skips the LLM entirely (see
	// correction.EscalationPolicy.ShouldEscalate's calibrated parameter).
	// Setting this true implies calibrator CONSTRUCTION in main even when
	// GF_CONFIDENCE_CALIBRATION is false — main's condition is
	// `cfg.ConfidenceCalibration || cfg.EscalationCalibrated`. Conversely,
	// GF_CONFIDENCE_CALIBRATION alone (this flag false) changes only the
	// response's displayed confidence values, never routing. Default false;
	// enabling is an eval-gated operator action — see the operator enable
	// protocol in eval/README.md.
	EscalationCalibrated bool // GF_ESCALATION_CALIBRATED (default false)

	// Task 8: N-best LLM sampling with majority-vote merge (GF_LLM_NBEST).
	// LLMNBest is the number of candidate completions requested per
	// escalation/LLM-only call; default 1 = off = byte-identical legacy
	// single-candidate behaviour. >= 2 enables N-best (correction.Service.
	// SetNBest), and requires the configured LLM client to implement
	// correction.NBestLLMClient — main.go type-asserts once at wiring time
	// and logs a Warn (not per request) if the assertion fails, leaving the
	// legacy single-candidate path in place.
	LLMNBest int // GF_LLM_NBEST (default 1)
	// LLMNBestTemperature is the sampling temperature used for N-best
	// candidate generation (both wire strategies below). Only takes effect
	// when LLMNBest >= 2; the legacy single-candidate path always keeps
	// Prompt.Temperature at its existing value (0 for correction — greedy,
	// golden-eval stable) untouched.
	LLMNBestTemperature float64 // GF_LLM_NBEST_TEMPERATURE (default 0.3)
	// LLMNBestWire selects the N-best transport strategy:
	//   - "sequential" (default): N separate requests, request i (0-based)
	//     using seed LLMSeed+i and the same prompt. Portable — works against
	//     any OpenAI-compatible BYO backend regardless of whether it honors
	//     the "n" parameter.
	//   - "n_param": ONE request with "n": N added to the payload. Only
	//     honored by backends implementing OpenAI's n parameter — verified
	//     live against llama.cpp build b9828-ebd048fc5, which DOES honor it,
	//     but a generic BYO backend may silently ignore it and return 1
	//     choice (llm.Client.CompleteN's short-subset handling covers that).
	// Invalid values fall back to "sequential" with a Warn (see
	// validateNBestWire) — mirroring clampGECToRPasses's posture: an
	// out-of-range/typo'd knob degrades to the safe default rather than
	// silently disabling the whole feature or panicking.
	LLMNBestWire string // GF_LLM_NBEST_WIRE (default "sequential")
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

		LLMRetryEnabled:     getBool("GF_LLM_RETRY_ENABLED", true),
		LLMRetryMaxRetries:  getInt("GF_LLM_RETRY_MAX_RETRIES", 1),
		LLMRetryBaseDelay:   getDuration("GF_LLM_RETRY_BASE_DELAY", 200*time.Millisecond),
		LLMRetryMaxDelay:    getDuration("GF_LLM_RETRY_MAX_DELAY", 500*time.Millisecond),
		LLMBreakerEnabled:   getBool("GF_LLM_BREAKER_ENABLED", true),
		LLMBreakerThreshold: getInt("GF_LLM_BREAKER_THRESHOLD", 5),
		LLMBreakerCooldown:  getDuration("GF_LLM_BREAKER_COOLDOWN", 30*time.Second),
		DBPath:              get("GF_DB_PATH", "/data/corrections.db"),
		LogLevel:            get("GF_LOG_LEVEL", "info"),

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
		GECToRPasses:              clampGECToRPasses(getInt("GF_GECTOR_PASSES", 1)),
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
		LLMSentenceContext:        getBool("GF_LLM_SENTENCE_CONTEXT", false),

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

		ConfidenceCalibration: getBool("GF_CONFIDENCE_CALIBRATION", false),
		CalibrationTTLSeconds: getInt("GF_CALIBRATION_TTL_SECONDS", 300),
		CalibrationMinSamples: getInt("GF_CALIBRATION_MIN_SAMPLES", 10),

		EscalationCalibrated: getBool("GF_ESCALATION_CALIBRATED", false),

		LLMNBest:            getInt("GF_LLM_NBEST", 1),
		LLMNBestTemperature: getFloat("GF_LLM_NBEST_TEMPERATURE", 0.3),
		LLMNBestWire:        validateNBestWire(get("GF_LLM_NBEST_WIRE", "sequential")),
	}
}

// validateNBestWire validates GF_LLM_NBEST_WIRE against the two known
// strategies ("sequential" | "n_param"), falling back to "sequential" (the
// portable BYO-safe default) with a Warn on any other value. Mirrors
// clampGECToRPasses's "log only when the input actually needed correcting"
// posture — the zero-value/default-returned "sequential" never logs.
func validateNBestWire(v string) string {
	switch v {
	case "sequential", "n_param":
		return v
	default:
		slog.Warn("GF_LLM_NBEST_WIRE invalid; falling back to sequential", "requested", v)
		return "sequential"
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

// clampGECToRPasses bounds GF_GECTOR_PASSES to [1,3] (see the GECToRPasses
// field doc comment for why), logging a Warn only when clamping actually
// changes the requested value so a misconfigured deploy is visible in logs.
func clampGECToRPasses(n int) int {
	clamped := n
	switch {
	case clamped < 1:
		clamped = 1
	case clamped > 3:
		clamped = 3
	}
	if clamped != n {
		slog.Warn("GF_GECTOR_PASSES out of range [1,3]; clamped", "requested", n, "clamped", clamped)
	}
	return clamped
}

// FromOS is the production loader.
func FromOS() Config { return Load(os.LookupEnv) }
