package correction

import "context"

// Request is one unit of text to check, with provenance for logging/signals.
type Request struct {
	Text   string
	Source Source
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

// Store persists correction events and user signals (SQLite in Plan 1B).
type Store interface {
	LogCorrection(ctx context.Context, ev Event) (id int64, err error)
	LogSignal(ctx context.Context, correctionID int64, signal Signal) error
	// CountCorrections returns the total number of logged corrections.
	CountCorrections(ctx context.Context) (int64, error)
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
