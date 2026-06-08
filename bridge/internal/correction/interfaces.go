package correction

import "context"

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
}

// Prompt is a backend-agnostic prompt; the LLMClient renders it to the wire.
type Prompt struct {
	System   string // empty for GRMR-native
	User     string
	Stop     []string
	Template PromptTemplate
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

// PersonalizationData is the aggregated accept/reject history used to build the
// prompt-cache few-shot examples (SPEC §5.5 — zero-compute personalisation).
type PersonalizationData struct {
	Accepted []EditPair // signal='accepted', most-recent-first, capped
	Rejected []EditPair // signal='rejected', grouped, Count>=3, capped
}

// Store persists correction events and user signals (SQLite in Plan 1B).
type Store interface {
	LogCorrection(ctx context.Context, ev Event) (id int64, err error)
	LogSignal(ctx context.Context, correctionID int64, signal Signal) error
	// CountCorrections returns the total number of logged corrections.
	CountCorrections(ctx context.Context) (int64, error)
	// PersonalizationExamples aggregates the signal log into the few-shot
	// pairs used to personalise the chat system prompt. Implementations must
	// cap the result (e.g. 20 accepted / 20 rejected) and drop rejected
	// pairs with Count < 3.
	PersonalizationExamples(ctx context.Context) (PersonalizationData, error)
	Close() error
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
}
