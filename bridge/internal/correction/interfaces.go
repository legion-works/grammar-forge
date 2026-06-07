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

// LLMClient is the slow-path escalation engine (any OpenAI-compatible backend).
type LLMClient interface {
	// Correct returns the corrected full text for req.Text.
	Correct(ctx context.Context, req Request) (string, error)
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

const (
	TemplateGRMRNative   PromptTemplate = "grmr_native"   // /v1/completions
	TemplateChatInstruct PromptTemplate = "chat_instruct" // /v1/chat/completions
)

// Store persists correction events and user signals (SQLite in Plan 1B).
type Store interface {
	LogCorrection(ctx context.Context, ev CorrectionEvent) (id int64, err error)
	LogSignal(ctx context.Context, correctionID int64, signal Signal) error
	Close() error
}

// Signal is a user reaction to a suggestion.
type Signal string

const (
	SignalAccepted Signal = "accepted"
	SignalRejected Signal = "rejected"
	SignalIgnored  Signal = "ignored"
)

// CorrectionEvent is a row in the correction log.
type CorrectionEvent struct {
	Source     Source
	Original   string
	Suggestion string
	Model      Model
	RuleID     string
	Context    string
	BaseModel  string // LLM model id, when Model == ModelLLM
	Adapter    string // active LoRA adapter id, if any (Phase 3)
}
