// Package prompt builds model-family-specific prompts. It implements
// correction.PromptBuilder and branches on the configured LLM format.
package prompt

import (
	"strings"

	"github.com/grammarforge/bridge/internal/correction"
)

// systemPrompt is the instruction used for generic instruct models (chat_instruct).
// It is deliberately strict about MINIMAL edits: capable instruct models (e.g.
// Gemma) otherwise rephrase/restyle clean text, which is a false positive in a
// suggest-then-confirm grammar tool. It also forbids accent/diacritic stripping
// and altering already-correct subject-verb agreement — two over-correction
// patterns observed in the held-out eval. (The default model GRMR-V3 uses
// grmr_native and never sees this prompt.)
const systemPrompt = "You are a grammar corrector. Fix ONLY objective grammatical, spelling, " +
	"and punctuation errors. Make the minimum changes necessary. Do NOT rephrase, restyle, " +
	"shorten, reorder words for style, or change word choice. Preserve the user's meaning, " +
	"voice, and every already-correct word. NEVER remove or alter accents or diacritics " +
	"(e.g. keep café, naïve, résumé exactly). NEVER change subject-verb agreement that is " +
	"already correct. If the text has no errors, return it EXACTLY unchanged. Return ONLY " +
	"the corrected text — no explanation, quotes, or preamble."

// rephraseSystemPrompt is the instruction used for the chat_instruct rephrase
// path. It is INTENTIONALLY separate from systemPrompt: grammar correction is
// about minimal edits, rephrase is about rewriting for clarity and fluency.
// Tone/style are appended only when set so empty values don't add dangling
// fragments to the prompt.
const rephraseSystemPrompt = "You are a writing assistant. Rewrite the user's text to be " +
	"clearer, more fluent, and easier to read while preserving the original meaning. " +
	"Fix grammar, spelling, and punctuation as part of the rewrite. " +
	"Return ONLY the rewritten text — no explanation, quotes, or preamble."

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

// BuildRephrase renders a rephrase request into a Prompt. Chat models receive
// the rephrase system prompt (with optional tone/style appended); GRMR-V3's
// native format has no instruction slot and is correction-tuned, not
// rephrase-tuned, so GRMR's best-effort is "minimally correct, do not restyle".
// The caller (REST handler) decides what to do with the returned text; this
// function is pure prompt shaping.
func (b *Builder) BuildRephrase(req correction.RephraseRequest) correction.Prompt {
	if b.chat {
		sys := rephraseSystemPrompt
		if t := strings.TrimSpace(req.Tone); t != "" {
			sys += " Rewrite in a " + t + " tone."
		}
		if s := strings.TrimSpace(req.Style); s != "" {
			sys += " Use a " + s + " style."
		}
		return correction.Prompt{
			System:   sys,
			User:     req.Text,
			Template: correction.TemplateChatInstruct,
		}
	}
	// GRMR-native: best-effort. No system prompt; the native envelope will
	// make the model minimally correct (same as Build).
	return correction.Prompt{
		User:     "<|text_start|>\n" + req.Text + "<|text_end|>\n<|corrected_start|>\n",
		Stop:     []string{"<|corrected_end|>", "<|text_start|>"},
		Template: correction.TemplateGRMRNative,
	}
}
