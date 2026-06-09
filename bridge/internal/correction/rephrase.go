package correction

// RephraseBackend selects the LLM backend for a rephrase call. Empty fields mean
// "use the service default". Provider is "openai" (default) or "anthropic".
type RephraseBackend struct {
	Provider string // "" | "openai" | "anthropic"
	BaseURL  string
	Model    string
	APIKey   string // never logged
}

// RephraseRequest is one unit of text to rewrite for fluency/clarity, with
// optional tone/style guidance. Source is provenance for any logging/metrics.
// Alternatives requests N variants (0/1 = single). Override, when non-nil,
// selects a one-shot backend for THIS call only.
type RephraseRequest struct {
	Text         string
	Tone         string // optional ("formal", "casual", ...). Empty => no tone guidance.
	Style        string // optional ("concise", "verbose", ...). Empty => no style guidance.
	Alternatives int
	Override     *RephraseBackend // nil => service default backend
	Source       Source
}

// RephraseResult is what the rephrase endpoint returns. Alternatives is
// reserved for a future "give me N variants" feature; always empty today.
type RephraseResult struct {
	Original     string
	Rephrased    string
	Alternatives []string
}
