package prompt

import (
	"strings"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

func TestGRMRNativeFormat(t *testing.T) {
	b := New("grmr_native")
	p := b.Build(correction.Request{Text: "I has a cat"})
	require.Equal(t, correction.TemplateGRMRNative, p.Template)
	require.Empty(t, p.System) // GRMR takes NO system prompt
	require.Equal(t, "<|text_start|>\nI has a cat<|text_end|>\n<|corrected_start|>\n", p.User)
	require.Equal(t, []string{"<|corrected_end|>", "<|text_start|>"}, p.Stop)
}

func TestChatInstructFormat(t *testing.T) {
	b := New("chat_instruct")
	p := b.Build(correction.Request{Text: "I has a cat"})
	require.Equal(t, correction.TemplateChatInstruct, p.Template)
	require.Contains(t, p.System, "grammar")
	require.Equal(t, "I has a cat", p.User)
}

func TestUnknownFormatFallsBackToGRMR(t *testing.T) {
	require.Equal(t, correction.TemplateGRMRNative, New("bogus").Build(correction.Request{Text: "x"}).Template)
}

func TestChatSystemPromptForbidsAccentAndAgreementOvercorrection(t *testing.T) {
	p := New("chat_instruct").Build(correction.Request{Text: "x"})
	require.Contains(t, p.System, "accents")
	require.Contains(t, p.System, "diacritics")
	require.Contains(t, p.System, "agreement")
}

// Rephrase uses a SEPARATE system prompt from the strict minimal-edit
// correction prompt: rephrase is intentionally about clarity/restyle, while
// grammar correction is intentionally minimal. Sharing the prompt would
// contradict the call (correct: minimal; rephrase: rewrite for fluency).
func TestBuildRephraseChat(t *testing.T) {
	b := New("chat_instruct")
	p := b.BuildRephrase(correction.RephraseRequest{Text: "He go to store."})
	require.Equal(t, correction.TemplateChatInstruct, p.Template)
	require.NotEmpty(t, p.System, "rephrase chat prompt must have a system prompt")
	require.Contains(t, strings.ToLower(p.System), "rewrite",
		"rephrase system prompt must instruct the model to rewrite")
	require.Contains(t, strings.ToLower(p.System), "meaning",
		"rephrase system prompt must instruct the model to preserve meaning")
	require.NotContains(t, p.System, "Make the minimum changes",
		"rephrase must NOT reuse the strict minimal-edit correction prompt")
	require.Equal(t, "He go to store.", p.User)
}

// Tone/style must be threaded into the prompt when set. Empty tone/style
// must NOT add "tone:" / "style:" fragments to the prompt.
func TestBuildRephraseToneStyle(t *testing.T) {
	b := New("chat_instruct")
	with := b.BuildRephrase(correction.RephraseRequest{
		Text: "x", Tone: "formal", Style: "concise",
	})
	require.Contains(t, strings.ToLower(with.System), "formal",
		"tone must appear in the rephrase prompt when set")
	require.Contains(t, strings.ToLower(with.System), "concise",
		"style must appear in the rephrase prompt when set")
	noTone := b.BuildRephrase(correction.RephraseRequest{Text: "x"})
	require.NotContains(t, strings.ToLower(noTone.System), "rewrite in a  tone",
		"empty tone must not add a trailing ' tone' fragment")
}

// GRMR-V3's native format has no instruction slot and is correction-tuned,
// not rephrase-tuned. Rephrase on GRMR is best-effort: the model minimally
// corrects instead of restyling. The returned prompt is the native envelope;
// the service-level contract is the same call path.
func TestBuildRephraseGRMRNative(t *testing.T) {
	b := New("grmr_native")
	p := b.BuildRephrase(correction.RephraseRequest{Text: "I has a cat"})
	require.Equal(t, correction.TemplateGRMRNative, p.Template)
	require.Empty(t, p.System, "GRMR-native takes no system prompt")
	require.Equal(t, "<|text_start|>\nI has a cat<|text_end|>\n<|corrected_start|>\n", p.User)
	require.Equal(t, []string{"<|corrected_end|>", "<|text_start|>"}, p.Stop)
}
