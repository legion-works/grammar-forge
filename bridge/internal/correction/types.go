// Package correction is the transport-agnostic core: domain types and the
// interfaces every model backend and store implements. It must not import any
// transport (HTTP/gRPC) or storage package.
package correction

import "fmt"

// Source identifies which client produced a request.
type Source string

// Source values for known clients.
const (
	SourceBrowser  Source = "browser"
	SourceVencord  Source = "vencord"
	SourceOpenCode Source = "opencode"
)

// Model identifies which engine produced a suggestion.
type Model string

// Model values for known engines.
const (
	ModelHarper Model = "harper"
	ModelGECToR Model = "gector"
	ModelLLM    Model = "llm"
	ModelLTRule Model = "lt_rule"
)

// Span is a half-open byte range [Start, End) into the UTF-8 text. Offsets are
// byte indices, not rune indices; callers dealing with user-visible characters
// must convert via utf8.RuneCountInString / range loops. The byte semantics let
// Apply do a constant-time slice without decoding the whole string.
type Span struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// Validate checks the byte span lies within a text of length textLen (bytes).
func (s Span) Validate(textLen int) error {
	if s.Start < 0 || s.End > textLen || s.Start > s.End {
		return fmt.Errorf("invalid byte span [%d,%d) for text length %d", s.Start, s.End, textLen)
	}
	return nil
}

// Suggestion is a single proposed edit. The bridge SUGGESTS; clients apply.
type Suggestion struct {
	Span        Span    `json:"span"`
	Replacement string  `json:"replacement"`
	Message     string  `json:"message,omitempty"`
	Model       Model   `json:"model"`
	RuleID      string  `json:"ruleId,omitempty"`
	Confidence  float64 `json:"confidence,omitempty"`
}

// Apply returns original with this suggestion's byte span replaced. Caller
// ensures the span is valid (see Span.Validate); Apply is total and clamps
// otherwise. The span is interpreted as byte offsets into the UTF-8 text.
func (s Suggestion) Apply(original string) string {
	if s.Span.Validate(len(original)) != nil {
		return original
	}
	return original[:s.Span.Start] + s.Replacement + original[s.Span.End:]
}

// Correction is the result for one input: the original plus ranked suggestions.
type Correction struct {
	Original    string       `json:"original"`
	Suggestions []Suggestion `json:"suggestions"`
	Score       int          `json:"score"` // 0-100 quality score
}
