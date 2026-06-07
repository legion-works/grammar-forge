// Package prompt builds model-family-specific prompts. It implements
// correction.PromptBuilder and branches on the configured LLM format.
package prompt

import "github.com/grammarforge/bridge/internal/correction"

// systemPrompt is the instruction used for generic instruct models (chat_instruct).
const systemPrompt = "You are a grammar and style corrector. Fix only genuine errors in " +
	"the user's text. Do not rewrite sentences. Do not change the user's intended meaning " +
	"or voice. Return ONLY the corrected text with no explanation."

// Builder implements correction.PromptBuilder for one configured format.
type Builder struct {
	chat bool // true => chat_instruct, false => grmr_native
}

// New returns a Builder for the given format ("chat_instruct" or "grmr_native").
// Any unknown value falls back to grmr_native (the default model is GRMR-V3).
func New(format string) *Builder {
	return &Builder{chat: format == "chat_instruct"}
}

// Build renders the request into a Prompt. GRMR-V3 takes NO system prompt and
// uses its native completion format; generic instruct models use chat+system.
func (b *Builder) Build(req correction.Request) correction.Prompt {
	if b.chat {
		return correction.Prompt{
			System:   systemPrompt,
			User:     req.Text,
			Template: correction.TemplateChatInstruct,
		}
	}
	return correction.Prompt{
		User:     "<|text_start|>\n" + req.Text + "<|text_end|>\n<|corrected_start|>\n",
		Stop:     []string{"<|corrected_end|>", "<|text_start|>"},
		Template: correction.TemplateGRMRNative,
	}
}
