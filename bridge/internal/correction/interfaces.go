package correction

import (
	"context"
	"time"
)

// Request is one unit of text to check, with provenance for logging/signals.
type Request struct {
	Text   string
	Source Source
	// Picky enables a best-effort style/clarity pass on top of the grammar
	// pipeline (REST /correct only — the gRPC MatchRequest has no options
	// field, see SPEC §4.2). When true and the LLM is configured, the service
	// runs an additional style pass on the original text and merges any
	// style suggestions into the result with category="style". Grammar
	// suggestions are authoritative: any style edit that overlaps a grammar
	// edit is dropped. Picky defaults to false; clients opt in.
	Picky bool
}

// Corrector is a fast-path engine (Harper, GECToR). Implementations live in
// their own packages (internal/harper, internal/gector) and are wired in main.
type Corrector interface {
	// Name reports the model tag used in suggestions and logs.
	Name() Model
	// Correct returns suggestions for req.Text. It must not mutate the text.
	Correct(ctx context.Context, req Request) ([]Suggestion, error)
}

// LLMClient is the slow-path engine (any OpenAI-compatible backend). It is pure
// transport: it renders a prebuilt Prompt to the wire and returns corrected text.
type LLMClient interface {
	Complete(ctx context.Context, p Prompt) (string, error)
}

// RephraseClientFactory builds a one-shot LLMClient for a rephrase backend.
// Injected by main (the transport layer) so the correction core stays free of
// any concrete transport (llm) import. Returns an error for an unknown provider.
type RephraseClientFactory func(b RephraseBackend) (LLMClient, error)

// PromptBuilder turns a request into the model-family-specific prompt. The
// implementation branches on model family (GRMR-native vs generic chat+system).
type PromptBuilder interface {
	Build(req Request) Prompt
	BuildRephrase(req RephraseRequest) Prompt
	// BuildStyle returns the picky-mode style-pass prompt. On GRMR-native
	// (which is correction-tuned, not style-tuned) this returns the empty-
	// User skip signal so the service can short-circuit the LLM call. On
	// chat_instruct this returns a style/clarity-focused system prompt
	// distinct from the minimal-edit grammar prompt and the rephrase prompt.
	BuildStyle(req Request) Prompt
	// BuildWithSpellingHints renders the grammar prompt with fast-path
	// spelling candidates appended to the system prompt as arbitration
	// hints. On GRMR-native (no system slot) and on empty hints it MUST
	// return Build(req) byte-identical. See prompt.Builder for the
	// contract.
	BuildWithSpellingHints(req Request, hints []Suggestion) Prompt
	// BuildTone renders a tone-analysis prompt. On chat_instruct it returns a
	// system prompt fixing the tone vocabulary + a strict-JSON instruction with
	// User=text. On GRMR-native (no system slot, correction-tuned) it returns
	// an empty User as the skip signal (the service short-circuits, like
	// BuildStyle) since GRMR cannot do tone tagging.
	BuildTone(req ToneRequest) Prompt
	// BuildComplete renders a generative-continuation prompt. Completion is
	// inherently a chat task; even GRMR-native backends receive a chat_instruct
	// prompt as a best-effort fallback (the model is correction-tuned, not
	// completion-tuned, so quality is on the operator). The source scopes the
	// completion style — OpenCode gets a coding-agent-instruction prompt; every
	// other client gets standard prose continuation.
	BuildComplete(text string, source Source) Prompt
}

// Prompt is a backend-agnostic prompt; the LLMClient renders it to the wire.
type Prompt struct {
	System string // empty for GRMR-native
	User   string
	Stop   []string
	// Temperature is the sampling temperature for this prompt. The zero value
	// (0) means greedy/deterministic — every correction, rephrase, and tone
	// prompt leaves it 0 so their wire payload stays byte-identical (golden-eval
	// stable). Only completion sets a non-zero temperature, so its continuations
	// vary across different inputs instead of collapsing to one canonical output.
	Temperature float64
	Template    PromptTemplate
}

// PromptTemplate selects the wire format the LLMClient must use.
type PromptTemplate string

// PromptTemplate values for the LLM wire format.
const (
	TemplateGRMRNative   PromptTemplate = "grmr_native"   // /v1/completions
	TemplateChatInstruct PromptTemplate = "chat_instruct" // /v1/chat/completions
)

// EditPair is one original->suggestion edit with how many times it carried a
// given signal. Used to build the personalisation few-shot cache.
type EditPair struct {
	Original   string
	Suggestion string
	Count      int
}

// SignalCounts aggregates the edit-level signal log (the /stats payload's
// source). TotalEdits counts every logged edit; the per-signal counts are the
// edits a user explicitly reacted to. TotalEdits - (Accepted+Rejected+Ignored)
// edits are still unsignaled.
type SignalCounts struct {
	TotalEdits int64
	Accepted   int64
	Rejected   int64
	Ignored    int64
}

// PersonalizationData is the aggregated accept/reject history used to build the
// prompt-cache few-shot examples (SPEC §5.5 — zero-compute personalisation).
type PersonalizationData struct {
	Accepted []EditPair // signal='accepted', most-recent-first, capped
	Rejected []EditPair // signal='rejected', grouped, Count>=3, capped
}

// CategoryCount is one bucket of the per-category edit histogram surfaced on
// /stats.top_issues. The Category field is the raw value from edits.category
// (empty string = CategoryGrammar, "spelling" = CategorySpelling, etc.) so
// the wire shape matches the suggestion category on /correct.
type CategoryCount struct {
	Category string `json:"category"`
	Count    int64  `json:"count"`
}

// StatsExtended is the retention field block on /stats — the part of the
// payload that turns the signal log into a habit signal for the user. All
// three fields are computed from the corrections + edits tables by
// Store.CountStatsExtended; the wire JSON tag names are the public API
// surface used by the browser and Vencord clients (see the redesign
// foundations plan, Area 3).
//
//   - TopIssues     : per-category edit counts, ordered by count DESC, with
//     category as a stable tiebreak. Signalless edits are
//     included — "what the corrector flagged" is the habit
//     signal, not "what the user accepted".
//   - Streak        : number of consecutive UTC days (ending today, with
//     the supplied `now` as the reference point) on which
//     at least one correction was logged. A gap of >=1 day
//     breaks the chain. 0 when today is not active.
//   - WordsThisWeek : sum of whitespace-delimited word counts of
//     corrections.suggestion over the inclusive 7-day
//     window ending at `now`. APPROXIMATE — exact for the
//     rows in the window, but no precomputed word_count
//     column exists on corrections; a dedicated
//     `word_count INTEGER` column (set at LogCorrection
//     time) would make the query O(1) and would also
//     include checked-but-uncorrected sentences that
//     never get a corrections row.
type StatsExtended struct {
	TopIssues     []CategoryCount `json:"top_issues"`
	Streak        int             `json:"streak"`
	WordsThisWeek int64           `json:"words_this_week"`
}

// EditRecord is one edit within a logged correction event — the unit a user
// signal attributes to. Original is the EXACT spanned source text.
type EditRecord struct {
	SpanStart   int
	SpanEnd     int
	Original    string
	Replacement string
	Model       Model
	Category    string
	RuleID      string
	Confidence  float64
}

// WordAllowlist reports whether a word is in the user dictionary. Injected
// by main (the dictionary store implements it) so the correction core stays
// free of file/transport concerns. Membership is case-insensitive.
type WordAllowlist interface {
	Contains(word string) bool
}

// Store persists correction events and user signals (SQLite in Plan 1B).
type Store interface {
	// LogCorrection inserts the event plus one edits row per Event.Edits entry.
	// Returns the correction row id and the edit row ids (parallel to Edits).
	LogCorrection(ctx context.Context, ev Event) (id int64, editIDs []int64, err error)
	LogSignal(ctx context.Context, correctionID int64, signal Signal) error
	// CountCorrections returns the total number of logged corrections.
	CountCorrections(ctx context.Context) (int64, error)
	// CountSignals aggregates the edits table by signal value for /stats.
	CountSignals(ctx context.Context) (SignalCounts, error)
	// CountStatsExtended aggregates the retention fields on /stats
	// (top_issues / streak / words_this_week). `now` is the reference
	// time for the streak (today) and the 7d words window — the production
	// caller passes time.Now(); tests pin it to a synthetic date so the
	// streak and 7d window are deterministic. See StatsExtended.
	CountStatsExtended(ctx context.Context, now time.Time) (StatsExtended, error)
	// PersonalizationExamples aggregates the signal log into the few-shot
	// pairs used to personalise the chat system prompt. Implementations must
	// cap the result (e.g. 20 accepted / 20 rejected) and drop rejected
	// pairs with Count < 3.
	PersonalizationExamples(ctx context.Context) (PersonalizationData, error)
	// LogTone records a tone-analysis event for the Phase-3 signal log.
	// Best-effort: the service swallows errors so /tone never fails on log
	// problems. Target is reserved (client-supplied desired tone, empty in v1).
	LogTone(ctx context.Context, ev ToneEvent) error
	Close() error
}

// ToneEvent is one tone-analysis record for the Phase-3 signal log. Target is
// reserved (client-supplied desired tone, empty in v1).
type ToneEvent struct {
	TextHash string
	Tags     []ToneTag
	Target   string
	Source   Source
}

// Signal is a user reaction to a suggestion.
type Signal string

// Signal values for user reactions to a suggestion.
const (
	SignalAccepted Signal = "accepted"
	SignalRejected Signal = "rejected"
	SignalIgnored  Signal = "ignored"
)

// Event is a row in the correction log.
type Event struct {
	Source     Source
	Original   string
	Suggestion string
	Model      Model
	RuleID     string
	Context    string
	BaseModel  string // LLM model id, when Model == ModelLLM
	Adapter    string // active LoRA adapter id, if any (Phase 3)
	// Edits is the per-suggestion breakdown of this event. Each edit gets its
	// own row + id so /signal attributes to ONE edit, not the whole rewrite.
	Edits []EditRecord
}
