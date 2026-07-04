// Package correction is the transport-agnostic core: domain types and the
// interfaces every model backend and store implements. It must not import any
// transport (HTTP/gRPC) or storage package.
package correction

import "fmt"

// Source identifies which client produced a request.
type Source string

// Source values for known clients.
const (
	SourceBrowser      Source = "browser"
	SourceVencord      Source = "vencord"
	SourceOpenCode     Source = "opencode"
	SourceLanguageTool Source = "languagetool" // gRPC RemoteRule path
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

// Suggestion categories. Grammar (the default, empty string) covers grammatical,
// spelling, and punctuation fixes; Style marks picky-mode style/clarity/word-choice
// suggestions (returned only when the REST /correct request sets picky=true).
const (
	CategoryGrammar = ""      // default — no JSON change for existing grammar suggestions
	CategoryStyle   = "style" // picky-mode style suggestion
)

// Additional categories surfaced on /correct so clients can colour/label
// suggestions. Grammar stays "" (CategoryGrammar) so its JSON is unchanged
// (back-compat). Only the Harper adapter sets these non-empty values today;
// GECToR + the LLM grammar diff stay CategoryGrammar.
const (
	CategorySpelling    = "spelling"
	CategoryPunctuation = "punctuation"
	CategoryTypography  = "typography"
	CategoryUnknown     = "unknown"
)

// IsTrustableCategory reports whether name is a fast-path category eligible
// for the trusted-set escalation skip (correction.EscalationPolicy.TrustedCategories).
// Grammar (CategoryGrammar, the empty string) is intentionally NOT trustable:
// a grammar fast-path edit is exactly what the LLM exists to override, so
// even if a future config path forgets to validate the parser output the
// routing invariant holds. This is the single source of truth consumed by
// both the config parser (config.parseTrustedCategories) and by the routing
// layer's defensive guard (everyCategoryTrusted → isCategoryTrusted).
func IsTrustableCategory(name string) bool {
	switch name {
	case CategorySpelling, CategoryPunctuation, CategoryTypography, CategoryStyle:
		return true
	}
	return false
}

// Suggestion is a single proposed edit. The bridge SUGGESTS; clients apply.
type Suggestion struct {
	// ID is the correction-log row id, set after the suggestion is persisted,
	// so clients can reference it in POST /signal. Zero until logged.
	ID          int64  `json:"id,omitempty"`
	Span        Span   `json:"span"`
	Replacement string `json:"replacement"`
	// Replacements is the full candidate list (primary first), always populated
	// with at least Replacement when there is an edit. Clients show "Apply" for
	// one and a "Show N more" expander for many. Empty only for flag-only lints
	// (no suggested edit).
	Replacements []string `json:"replacements,omitempty"`
	Message      string   `json:"message,omitempty"`
	Model        Model    `json:"model"`
	RuleID       string   `json:"ruleId,omitempty"`
	Confidence   float64  `json:"confidence,omitempty"`
	// Category tags the suggestion origin. Empty (CategoryGrammar) for the
	// default grammar pipeline so JSON output is unchanged; "style" (CategoryStyle)
	// for the picky-mode style pass so clients can render/hide style suggestions
	// separately. Serialised with omitempty so the field is absent on JSON for
	// grammar suggestions.
	Category string `json:"category,omitempty"`
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
