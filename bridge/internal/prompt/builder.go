// Package prompt builds model-family-specific prompts. It implements
// correction.PromptBuilder and branches on the configured LLM format.
package prompt

import (
	"strconv"
	"strings"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/grammarforge/bridge/internal/personalization"
)

// Personalizer supplies the learned-preference few-shot block to inject
// into the chat system prompt. nil => no personalisation. Defined here as
// a tiny interface so the prompt package does not hard-depend on the
// concrete *personalization.Cache (the prompt builder only needs
// Snapshot()).
type Personalizer interface {
	Snapshot() personalization.Block
}

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

// styleSystemPrompt is the instruction used for the chat_instruct picky-mode
// STYLE pass. It is INTENTIONALLY separate from both systemPrompt and
// rephraseSystemPrompt: picky is a layer ON TOP of grammar (a peer of the
// grammar pass, not a replacement) and asks for word-choice, conciseness,
// flow, and readability improvements WITHOUT changing the meaning. It is
// NOT a rephrase: the user is choosing to see style suggestions in addition
// to grammar ones, so the rewrite must stay close to the original. Grammar
// errors are still flagged on the grammar pass; style is ONLY style/clarity.
const styleSystemPrompt = "You are a writing style assistant. Suggest STYLE and CLARITY " +
	"improvements (word choice, conciseness, flow, readability) WITHOUT changing " +
	"the meaning, voice, or grammar of the original. Make the changes minimal — " +
	"this is a suggest-then-confirm pass, not a rewrite. Preserve the user's " +
	"meaning exactly. NEVER remove or alter accents or diacritics (e.g. keep " +
	"café, naïve, résumé exactly). Return ONLY the improved text — no explanation, " +
	"quotes, or preamble."

// Builder implements correction.PromptBuilder for one configured format.
type Builder struct {
	chat         bool // true => chat_instruct, false => grmr_native
	personalizer Personalizer
}

// New returns a Builder for the given format ("chat_instruct" or "grmr_native").
// Any unknown value falls back to grmr_native (the default model is GRMR-V3).
// The returned builder has no personaliser — use NewWithPersonalizer to wire
// the prompt-cache few-shot block.
func New(format string) *Builder {
	return &Builder{chat: format == "chat_instruct"}
}

// NewWithPersonalizer returns a Builder that injects the personalisation
// block (when non-empty) into the chat system prompt. The personaliser is
// only consulted on the chat path and only on Build; BuildRephrase and
// BuildStyle ignore it — the accept/reject signal log feeds the GRAMMAR
// pass, not rephrasing or picky style suggestions. GRMR-native never
// receives a system prompt, so the personaliser is also a no-op on that
// path.
func NewWithPersonalizer(format string, p Personalizer) *Builder {
	b := New(format)
	b.personalizer = p
	return b
}

// Build renders the request into a Prompt. GRMR-V3 takes NO system prompt and
// uses its native completion format; generic instruct models use chat+system.
// On the chat path, a non-empty personaliser Block is appended to the base
// system prompt so the LLM sees the few-shot examples.
func (b *Builder) Build(req correction.Request) correction.Prompt {
	if b.chat {
		sys := systemPrompt
		if b.personalizer != nil {
			if block := b.personalizer.Snapshot(); !block.Empty() {
				sys += block.String()
			}
		}
		return correction.Prompt{
			System:   sys,
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
		// Tone/Style are untrusted client text from the /rephrase request
		// JSON. Render each through strconv.Quote (Go-escaped quoted
		// string literal) so an embedded quote, newline, or control char
		// cannot break out of the connective text and inject a new
		// instruction into the system prompt. This is the same defence as
		// the P4 fix in internal/personalization/cache.go for the
		// user-signal few-shot block.
		if t := strings.TrimSpace(req.Tone); t != "" {
			sys += " Rewrite in a " + strconv.Quote(t) + " tone."
		}
		if s := strings.TrimSpace(req.Style); s != "" {
			sys += " Use a " + strconv.Quote(s) + " style."
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

// BuildStyle renders a picky-mode style-pass request into a Prompt. Chat
// models receive the style system prompt (focused on word choice, conciseness,
// flow, readability — NOT a rewrite). GRMR-native is a no-op: picky-mode is a
// chat-model feature; the native format is correction-tuned and would just
// re-do the grammar pass. The empty-User signal is the skip sentinel the
// service checks to short-circuit the LLM call entirely.
func (b *Builder) BuildStyle(req correction.Request) correction.Prompt {
	if b.chat {
		return correction.Prompt{
			System:   styleSystemPrompt,
			User:     req.Text,
			Template: correction.TemplateChatInstruct,
		}
	}
	// GRMR-native: no-op. Picky-mode is a chat-model feature; the native
	// format is correction-tuned. Return the empty-User skip signal so the
	// service can short-circuit the LLM call.
	return correction.Prompt{
		User:     "",
		Template: correction.TemplateGRMRNative,
	}
}
