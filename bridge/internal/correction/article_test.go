package correction

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// ---- applyArticleFixes unit tests ----

func TestApplyArticleFixesGolden79(t *testing.T) {
	// The [79] golden case: silent-h "honest" must be fixed.
	require.Equal(t, "an honest review", applyArticleFixes("a honest review"))
}

func TestApplyArticleFixesHour(t *testing.T) {
	require.Equal(t, "an hour", applyArticleFixes("a hour"))
}

func TestApplyArticleFixesHeir(t *testing.T) {
	require.Equal(t, "an heir", applyArticleFixes("a heir"))
}

func TestApplyArticleFixesHonor(t *testing.T) {
	require.Equal(t, "an honor", applyArticleFixes("a honor"))
}

func TestApplyArticleFixesHonour(t *testing.T) {
	require.Equal(t, "an honour", applyArticleFixes("a honour"))
}

func TestApplyArticleFixesCasePreservedUpperA(t *testing.T) {
	// "A" -> "An" (sentence-initial capital preserved)
	require.Equal(t, "An honest mistake", applyArticleFixes("A honest mistake"))
}

func TestApplyArticleFixesPrefixCoverageHonorable(t *testing.T) {
	// "honorable" starts with "honor" stem -> covered
	require.Equal(t, "an honorable man", applyArticleFixes("a honorable man"))
}

func TestApplyArticleFixesPrefixCoverageHourly(t *testing.T) {
	// "hourly" starts with "hour" stem -> covered
	require.Equal(t, "an hourly rate", applyArticleFixes("a hourly rate"))
}

func TestApplyArticleFixesPrefixCoverageHonestly(t *testing.T) {
	require.Equal(t, "an honestly spoken word", applyArticleFixes("a honestly spoken word"))
}

func TestApplyArticleFixesPrefixCoverageHeiress(t *testing.T) {
	require.Equal(t, "an heiress", applyArticleFixes("a heiress"))
}

func TestApplyArticleFixesPrefixCoverageHourglass(t *testing.T) {
	require.Equal(t, "an hourglass", applyArticleFixes("a hourglass"))
}

// ---- NEGATIVE tests: must stay UNCHANGED ----

func TestApplyArticleFixesAlreadyCorrect(t *testing.T) {
	// Already "an honest" — must not double-fix.
	require.Equal(t, "an honest review", applyArticleFixes("an honest review"))
}

func TestApplyArticleFixesPronouncedHHouse(t *testing.T) {
	// "house" has a pronounced h — NOT in the silent-h list.
	require.Equal(t, "a house", applyArticleFixes("a house"))
}

func TestApplyArticleFixesPronouncedHHorse(t *testing.T) {
	require.Equal(t, "a horse", applyArticleFixes("a horse"))
}

func TestApplyArticleFixesPronouncedHHotel(t *testing.T) {
	require.Equal(t, "a hotel", applyArticleFixes("a hotel"))
}

func TestApplyArticleFixesPronouncedHHawk(t *testing.T) {
	require.Equal(t, "I saw a hawk", applyArticleFixes("I saw a hawk"))
}

func TestApplyArticleFixesVowelLetterApple(t *testing.T) {
	// "a apple" is Harper's job (vowel letter); not in our silent-h list.
	require.Equal(t, "a apple", applyArticleFixes("a apple"))
}

func TestApplyArticleFixesBanana(t *testing.T) {
	require.Equal(t, "a banana", applyArticleFixes("a banana"))
}

func TestApplyArticleFixesNoArticle(t *testing.T) {
	// No article at all — unchanged.
	require.Equal(t, "vanilla", applyArticleFixes("vanilla"))
}

func TestApplyArticleFixesMidTextSilentH(t *testing.T) {
	// "a honest" appearing mid-sentence must still be fixed.
	require.Equal(t, "She gave an honest answer.", applyArticleFixes("She gave a honest answer."))
}

// ---- Idempotence ----

func TestApplyArticleFixesIdempotent(t *testing.T) {
	cases := []string{
		"a honest review",
		"an honest review",
		"a house",
		"A honest mistake",
		"a hourly rate",
	}
	for _, c := range cases {
		once := applyArticleFixes(c)
		twice := applyArticleFixes(once)
		require.Equal(t, once, twice, "not idempotent on: %q", c)
	}
}

// ---- Service-level integration test ----
// With a fake LLM that returns the input UNCHANGED (misses the a/an fix),
// the pipeline must still emit the "a"→"an" suggestion via the post-LLM
// article repair.

func TestServiceEscalationArticleFixAppliedWhenLLMMisses(t *testing.T) {
	// Escalation path: a low-confidence fast edit forces escalation.
	// The LLM returns the original text unchanged (it missed the a/an fix).
	// The post-LLM article repair must still emit a suggestion that, when
	// applied, produces "an honest review".
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{0, 1}, Replacement: "a", Model: ModelGECToR, Confidence: 0.3}},
	}
	svc := NewService(fakePB{}, []Corrector{fc},
		fakeLLM{out: "a honest review"},
		st, "m", fastPolicy())
	svc.SetArticleFix(true)

	got, err := svc.Correct(context.Background(), Request{Text: "a honest review"})
	require.NoError(t, err)
	// The pipeline must have produced at least one suggestion.
	require.NotEmpty(t, got.Suggestions, "article fix must fire even when LLM misses it")
	// Apply all suggestions to the original text and verify the result is
	// "an honest review". This is the correct way to verify the diff output
	// regardless of how the diff represents the "a"→"an" change (insertion,
	// replacement, etc.).
	result := "a honest review"
	for _, s := range got.Suggestions {
		result = s.Apply(result)
	}
	require.Equal(t, "an honest review", result,
		"applying suggestions must yield 'an honest review'; suggestions: %+v", got.Suggestions)
}

func TestServiceArticleFixDisabledDoesNotFire(t *testing.T) {
	// With articleFix disabled, the LLM's unchanged output is diffed as-is.
	// The fast corrector's low-confidence edit forces escalation.
	st := &fakeStore{}
	fc := fakeCorrector{
		name: string(ModelGECToR),
		sugs: []Suggestion{{Span: Span{0, 1}, Replacement: "a", Model: ModelGECToR, Confidence: 0.3}},
	}
	svc := NewService(fakePB{}, []Corrector{fc},
		fakeLLM{out: "a honest review"},
		st, "m", fastPolicy())
	svc.SetArticleFix(false)

	got, err := svc.Correct(context.Background(), Request{Text: "a honest review"})
	require.NoError(t, err)
	// LLM returned the same text → diff produces no suggestions.
	for _, s := range got.Suggestions {
		require.NotEqual(t, "an", s.Replacement, "article fix must not fire when disabled")
	}
}
