package correction

// ToneTag is one detected tone with its confidence (0..1).
type ToneTag struct {
	Tag        string
	Confidence float64
}

// ToneGranularity selects the analysis unit.
type ToneGranularity string

// ToneGranularity values.
const (
	ToneGranularityField    ToneGranularity = "field"
	ToneGranularitySentence ToneGranularity = "sentence"
)

// ToneSentence is one per-sentence tone result (half-open byte span [Start,End)
// into the request text + its tags).
type ToneSentence struct {
	Start int
	End   int
	Tags  []ToneTag
}

// ToneRequest is one tone-analysis call. Granularity selects whole-text
// ("field", the default) or per-sentence ("sentence"). Override, when non-nil,
// selects a one-shot backend for THIS call only (mirrors RephraseRequest).
type ToneRequest struct {
	Text        string
	Granularity ToneGranularity
	Source      Source
	Override    *RephraseBackend
}

// ToneResult is what AnalyzeTone returns. Sentences is populated only for
// granularity "sentence"; Tags is the field-level tag set (the aggregate of the
// sentence tags on the sentence path).
type ToneResult struct {
	Tags      []ToneTag
	Sentences []ToneSentence
}

// ToneTags is the fixed, co-occurring tone vocabulary. Tunable here; keep in
// sync with the tone system prompt in internal/prompt/builder.go.
var ToneTags = []string{
	"neutral", "formal", "casual", "friendly", "polite", "confident", "direct",
	"frustrated", "aggressive", "anxious", "sarcastic", "passive-aggressive",
	"optimistic", "urgent", "sincere",
}

// allowedToneTag reports whether tag is in the fixed vocabulary.
func allowedToneTag(tag string) bool {
	for _, t := range ToneTags {
		if t == tag {
			return true
		}
	}
	return false
}
