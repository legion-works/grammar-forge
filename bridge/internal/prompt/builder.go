// Package prompt builds model-family-specific prompts. It implements
// correction.PromptBuilder and branches on the configured LLM format.
package prompt

import (
	"fmt"
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

// VocabularySource supplies the user-dictionary words injected into the chat
// system prompt as protected vocabulary (the dictionary store implements it).
// nil or an empty word list leaves the prompt BYTE-IDENTICAL to the
// vocabulary-less build — the committed eval baseline runs with an empty
// dictionary and must not shift. Post-hoc suppression (the correction
// service's WordAllowlist) only FILTERS LLM output; this is what stops the
// vocabulary-blind LLM from mangling dictionary words in the first place
// (verified live: a two-word dictionary name kept being rewritten into an
// unrelated phrase).
type VocabularySource interface {
	Words() []string
}

// maxVocabularyWords caps how many dictionary words are injected, bounding
// the prompt size (and the per-sentence cache key churn) for a pathologically
// large dictionary. The earliest entries win (file order — oldest first).
const maxVocabularyWords = 200

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
	vocabulary   VocabularySource
}

// SetVocabularySource injects the user dictionary whose words the chat
// prompts protect from "correction". Optional; nil (or an empty dictionary)
// keeps every prompt byte-identical. GRMR-native takes no system prompt, so
// the source is a no-op on that path.
func (b *Builder) SetVocabularySource(v VocabularySource) { b.vocabulary = v }

// vocabularyBlock renders the protected-words sentence appended to the chat
// system prompts, or "" when there is no vocabulary. Words are rendered via
// strconv.Quote — the dictionary is user-controlled text, and quoting keeps
// an embedded quote/control char from breaking out of the sentence (the same
// defence as the tone/style fields and the personalisation block).
func (b *Builder) vocabularyBlock() string {
	if b.vocabulary == nil {
		return ""
	}
	words := b.vocabulary.Words()
	if len(words) == 0 {
		return ""
	}
	if len(words) > maxVocabularyWords {
		words = words[:maxVocabularyWords]
	}
	quoted := make([]string, len(words))
	for i, w := range words {
		quoted[i] = strconv.Quote(w)
	}
	return " The user's personal dictionary contains these words; they are correct as " +
		"written — never change, respell, or remove them: " + strings.Join(quoted, ", ") + "."
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
		sys := systemPrompt + b.vocabularyBlock()
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

// maxSpellingHints caps how many Harper SPELLING candidates are appended to
// the escalation prompt. Bounds the prompt size on a noisy input — the LLM
// is asked to ARBITRATE the hints, not to follow them blindly, so a small
// sample is enough for the gating decision.
const maxSpellingHints = 8

// spellingHintsBlock is the connective sentence appended to the chat system
// prompt when fast-hint injection is on. Hint payload is the user's text
// (flagged token + candidate) so it must be safe to splice into an LLM
// instruction — see BuildWithSpellingHints for the rendering.
const spellingHintsBlock = " A separate spell-checker flagged possible misspellings with " +
	"candidate fixes: %s. These hints MAY BE WRONG. Fix a flagged token only when it " +
	"is a genuine misspelling in context; ignore the hint when the token is intentional " +
	"(a name, technical term, code, or identifier). Never apply a hint inside code."

// BuildWithSpellingHints renders the grammar prompt with fast-path spelling
// candidates appended to the system prompt as arbitration hints. On
// GRMR-native (no system slot) and on empty/all-invalid hints it MUST
// return Build(req) byte-identical. Used by the service in the LLM
// escalation branch when correction.Service.SetFastHintsEnabled is true.
//
// SECURITY: the flagged token AND the candidate are untrusted user-derived
// text. Both are rendered through strconv.Quote (Go-escaped quoted string
// literal) so an embedded quote, newline, or control char cannot break out
// of the connective sentence and inject a new prompt line. This is the
// same defence as the Tone/Style injection fix at builder.go:170-185 and
// the P4 fix in internal/personalization/cache.go. Untrusted freeform
// values from user text MUST be quoted, never concatenated raw.
func (b *Builder) BuildWithSpellingHints(req correction.Request, hints []correction.Suggestion) correction.Prompt {
	base := b.Build(req)
	if !b.chat {
		// GRMR-native has no system slot; the hints would have nowhere to
		// go. The LLM is correction-tuned and the merge is load-bearing,
		// but the system prompt cannot carry extra text. Return the base
		// build byte-identical so the GRMR eval baseline is preserved.
		return base
	}
	rendered := renderSpellingHints(req.Text, hints)
	if rendered == "" {
		// No usable hints (empty slice, or every entry skipped by the
		// span/replacement guard). Stay byte-identical to Build(req) so
		// the LLM still gets a deterministic prompt and the sentence-
		// cache key (which hashes only Build(req).System) stays valid.
		return base
	}
	out := base
	out.System = base.System + fmt.Sprintf(spellingHintsBlock, rendered)
	return out
}

// renderSpellingHints formats the hint payload ("x" -> "y", "a" -> "b") for
// the first maxSpellingHints usable hints, or returns "" when none survive.
// Usable means: a valid non-zero-width span AND a non-empty replacement. All
// of these are untrusted user-derived text — both the flagged token and the
// candidate are passed through strconv.Quote so a stray quote, newline, or
// control char cannot break out of the connective sentence.
func renderSpellingHints(text string, hints []correction.Suggestion) string {
	if len(hints) == 0 {
		return ""
	}
	var pairs []string
	for _, h := range hints {
		if len(pairs) >= maxSpellingHints {
			break
		}
		if h.Replacement == "" {
			continue
		}
		if h.Span.End <= h.Span.Start {
			continue
		}
		if h.Span.Validate(len(text)) != nil {
			continue
		}
		flagged := text[h.Span.Start:h.Span.End]
		pairs = append(pairs, strconv.Quote(flagged)+" -> "+strconv.Quote(h.Replacement))
	}
	if len(pairs) == 0 {
		return ""
	}
	return strings.Join(pairs, ", ")
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
		// The style pass must respect the protected vocabulary too — a
		// word-choice rewrite mangling a dictionary word is the same bug as
		// the grammar pass doing it. (Rephrase deliberately does NOT get the
		// block: a wholesale rewrite may legitimately drop any word.)
		return correction.Prompt{
			System:   styleSystemPrompt + b.vocabularyBlock(),
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
