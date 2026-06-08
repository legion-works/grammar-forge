package correction

// RephraseRequest is one unit of text to rewrite for fluency/clarity, with
// optional tone/style guidance. Source is provenance for any logging/metrics.
type RephraseRequest struct {
	Text   string
	Tone   string // optional ("formal", "casual", ...). Empty => no tone guidance.
	Style  string // optional ("concise", "verbose", ...). Empty => no style guidance.
	Source Source
}

// RephraseResult is what the rephrase endpoint returns. Alternatives is
// reserved for a future "give me N variants" feature; always empty today.
type RephraseResult struct {
	Original     string
	Rephrased    string
	Alternatives []string
}
