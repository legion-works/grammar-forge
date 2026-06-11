// Package prompt builds model-family-specific prompts. It implements
// correction.PromptBuilder and branches on the configured LLM format.
package prompt

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

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
//
// The block is CONDITIONALLY appended: the prompt only gains the protection
// sentence when the request text contains at least one dictionary word as a
// case-insensitive, word-boundary match. An unconditional protection
// sentence is a live-measured regression (Gemma-4 QAT, temp 0, byte-stable
// across restarts: golden cases 106/107/112 fail with the sentence present
// and pass with the bare prompt). The matching is matched-words-only — the
// sentence lists ONLY the entries that actually appear in the text.
type VocabularySource interface {
	Words() []string
}

// maxVocabularyWords caps how many MATCHED dictionary words are rendered
// in the protection sentence, bounding the prompt size (and the
// per-sentence cache key churn) for a request whose text happens to match
// many dictionary words. The dictionary SCAN is unbounded — every entry
// is checked for a match — so a request whose text only matches word
// #201 still gets its matched (single-entry) list rendered. Only the
// rendered sentence is bounded. The earliest matches win (file order).
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
// system prompts, or "" when there is no vocabulary OR no dictionary word
// appears in the request text. Conditional on the text: an unconditional
// block is a live-measured regression on Gemma-4 QAT (golden cases 106/107/
// 112 — discrete→discreet, complement→compliment, laying→lying — all FAIL
// with the sentence present and all PASS with the bare prompt). When
// rendered, the sentence lists ONLY the matched entries in dictionary file
// order, capped at maxVocabularyWords.
//
// A dictionary entry matches when it appears in the text as a contiguous,
// word-bounded, Unicode-case-fold-equal substring (the rune immediately
// before the match and the rune immediately after must be non-letter/
// non-digit, or the string edge). Punctuation INSIDE the dictionary word
// is consumed by the fold-prefix match — "Qwen3-4B" matches "Qwen3-4B" in
// the text, and "O'Connor" matches "O'Connor" — but the right-boundary
// check after the match keeps "Kins" from matching inside "napkins" and
// keeps "Verlan" matching "Verlan's" (the apostrophe is a non-letter
// boundary).
//
// The dictionary SCAN is unbounded — every entry is checked for a match
// (the cap bounds the rendered prompt size, not the scan, so word #201
// is still scanned if it's the only match). The fold-prefix scan walks
// text and the dictionary word rune by rune using rune-level Unicode
// case-fold equivalence, returning the byte length of the matched prefix
// in text (or -1). Byte-by-byte comparison would break for characters
// that fold to a different byte length (e.g. long-s "ſ", U+017F, 2 bytes
// folds to "s", 1 byte).
//
// Words are rendered via strconv.Quote — the dictionary is user-controlled
// text, and quoting keeps an embedded quote/control char from breaking out
// of the sentence (the same defence as the tone/style fields and the
// personalisation block).
func (b *Builder) vocabularyBlock(text string) string {
	if b.vocabulary == nil {
		return ""
	}
	words := b.vocabulary.Words()
	if len(words) == 0 {
		return ""
	}
	var matched []string
	for _, w := range words {
		if w == "" {
			continue
		}
		if containsDictionaryWord(text, w) {
			matched = append(matched, w)
		}
	}
	if len(matched) == 0 {
		return ""
	}
	if len(matched) > maxVocabularyWords {
		matched = matched[:maxVocabularyWords]
	}
	quoted := make([]string, len(matched))
	for i, w := range matched {
		quoted[i] = strconv.Quote(w)
	}
	return " The user's personal dictionary contains these words; they are correct as " +
		"written — never change, respell, or remove them: " + strings.Join(quoted, ", ") + "."
}

// containsDictionaryWord reports whether dictWord appears in text as a
// contiguous, word-bounded, case-fold-equal substring. The match must
// start at a word boundary (start of text or previous rune not letter/
// digit) and end at a word boundary (end of text or next rune not
// letter/digit). Punctuation INSIDE the dictionary word is consumed by
// the fold-prefix match — "Qwen3-4B" matches "Qwen3-4B" in the text —
// but the right-boundary check after the match keeps "Kins" from
// matching inside "napkins". Empty dictWord never matches.
//
// Walks the text at every rune-aligned position. At each position, runs
// foldPrefixLength; if the whole word is consumed AND both boundaries
// are non-word (or string edges), the match succeeds. The iteration
// advances by rune (not byte) because matches can only start at rune
// boundaries — valid UTF-8 never embeds ASCII bytes inside a multi-byte
// rune, so a rune-aligned start is the only place a match can begin.
func containsDictionaryWord(text, dictWord string) bool {
	if dictWord == "" {
		return false
	}
	pos := 0
	for pos <= len(text) {
		n := foldPrefixLength(text[pos:], dictWord)
		if n >= 0 {
			end := pos + n
			if isPromptWordBoundedAt(text, pos, end) {
				return true
			}
		}
		if pos >= len(text) {
			break
		}
		_, size := utf8.DecodeRuneInString(text[pos:])
		pos += size
	}
	return false
}

// foldPrefixLength reports the byte length of the longest prefix of
// text that case-folds-equal to the entirety of word, or -1 if no such
// prefix exists. Case equivalence uses unicode.SimpleFold (the same
// per-rune equivalence that strings.EqualFold uses for its case-fold
// check), so multi-byte characters that fold to a different byte
// length — e.g. the long-s "ſ" (U+017F, 2 bytes) which folds to "s"
// (1 byte) — match without breaking the comparison. Walks text and
// word rune by rune; returns -1 on the first mismatch. Returns 0 if
// word is empty (the empty string is a prefix of every string).
func foldPrefixLength(text, word string) int {
	if word == "" {
		return 0
	}
	ti := 0
	wi := 0
	for wi < len(word) {
		if ti >= len(text) {
			return -1
		}
		tr, tsize := utf8.DecodeRuneInString(text[ti:])
		wr, wsize := utf8.DecodeRuneInString(word[wi:])
		if !runesFoldEqual(tr, wr) {
			return -1
		}
		ti += tsize
		wi += wsize
	}
	return ti
}

// runesFoldEqual reports whether r1 and r2 are equal under Unicode
// simple case folding (the equivalence strings.EqualFold uses for its
// per-rune check). The check is symmetric: walks the case-fold class
// of each rune via unicode.SimpleFold in turn. The symmetric walk is
// required because SimpleFold's per-rune cycle may not include both
// sides of an equivalence — e.g. for "S" (U+0053) and "ſ" (U+017F),
// SimpleFold("S") cycles {S, s} without reaching "ſ"; only the walk
// from "ſ" reaches "S" via "s". For ASCII letters the first walk
// already finds the match; for non-ASCII fold pairs (long-s/s, final
// sigma/regular sigma, etc.) the second walk covers the bridge.
func runesFoldEqual(r1, r2 rune) bool {
	if r1 == r2 {
		return true
	}
	for rr := unicode.SimpleFold(r1); rr != r1; rr = unicode.SimpleFold(rr) {
		if rr == r2 {
			return true
		}
	}
	for rr := unicode.SimpleFold(r2); rr != r2; rr = unicode.SimpleFold(rr) {
		if rr == r1 {
			return true
		}
	}
	return false
}

// isPromptWordBoundedAt reports whether s[start:end] is bounded by
// non-word runes (or the string edges) on both sides. A "word rune"
// is unicode.IsLetter(r) || unicode.IsDigit(r). The same boundary
// definition is used by isWordBoundedAt in internal/correction/overedit.go
// and ExpandToWordBoundaries in internal/correction/segment.go. Mirror
// of the same-named helper in overedit.go; duplicated here to keep the
// prompt package free of correction-internals imports.
func isPromptWordBoundedAt(s string, start, end int) bool {
	if start > 0 {
		r, _ := utf8.DecodeLastRuneInString(s[:start])
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return false
		}
	}
	if end < len(s) {
		r, _ := utf8.DecodeRuneInString(s[end:])
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return false
		}
	}
	return true
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
		sys := systemPrompt + b.vocabularyBlock(req.Text)
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
			System:   styleSystemPrompt + b.vocabularyBlock(req.Text),
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
