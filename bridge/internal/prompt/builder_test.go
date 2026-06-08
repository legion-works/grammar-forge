package prompt

import (
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
