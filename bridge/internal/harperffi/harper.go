//go:build cgo

// Package harperffi wraps harper-core (Rust) via the hippietrail/harper-c C FFI
// and implements correction.Corrector. One LintGroup is cached per process
// (it carries the FST dictionary); one Document is created+freed per request.
//
// Build tag cgo is required (CGo dependency). Run with CGO_ENABLED=1; the
// native library libharper_c.so is expected in /usr/local/lib at runtime and
// in bridge/native at build time (rpath injected below).
package harperffi

/*
#cgo CFLAGS: -I${SRCDIR}/../../native
#cgo LDFLAGS: -L${SRCDIR}/../../native -lharper_c -Wl,-rpath,${SRCDIR}/../../native
#include <stdlib.h>
#include "harper_shim.h"
*/
import "C"

import (
	"context"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/grammarforge/bridge/internal/correction"
)

// Suggestion-kind codes returned by harper_get_suggestion via out_kind. These
// mirror the HARPER_SUGGESTION_* macros in harper.h and harper-core's
// Suggestion enum; kept as Go constants so the switch does not depend on cgo
// macro exposure.
const (
	suggestionReplaceWith = 0 // replace the lint range with the payload
	suggestionInsertAfter = 1 // insert the payload after the lint range
	suggestionRemove      = 2 // delete the lint range (no payload)
)

// Harper dialect codes. These mirror the HARPER_DIALECT_* macros in harper.h
// (a stable ABI defined by the harper-c fork, NOT harper-core's internal
// bit-flag discriminants).
const (
	dialectAmerican   = 0
	dialectBritish    = 1
	dialectCanadian   = 2
	dialectAustralian = 3
	dialectIndian     = 4
)

// DialectCode maps a dialect name (case-insensitive, surrounding space trimmed)
// to its FFI code; unknown or empty names fall back to American.
func DialectCode(name string) int {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "british":
		return dialectBritish
	case "canadian":
		return dialectCanadian
	case "australian":
		return dialectAustralian
	case "indian":
		return dialectIndian
	default:
		return dialectAmerican
	}
}

// Options configures the Harper corrector.
type Options struct {
	// Markdown parses input as Markdown so code spans, fenced code blocks, math,
	// and HTML are masked unlintable (reinforcing the "don't flag code"
	// invariant at the engine). When false, input is parsed as plain English.
	Markdown bool
	// IgnoreLinkTitle additionally masks Markdown link titles (only meaningful
	// when Markdown is true).
	IgnoreLinkTitle bool
	// Dialect is an FFI dialect code (see DialectCode / the dialect* consts);
	// the zero value is American.
	Dialect int
	// DisabledRules / EnabledRules are curated-rule keys (linter struct names,
	// e.g. "LongSentences", "SpellCheck") to force off / on at construction.
	// Disabled is applied first, then Enabled.
	DisabledRules []string
	EnabledRules  []string
	// MaxInputLen skips correction for inputs longer than this many bytes
	// (0 = no limit), bounding worst-case latency on pathological input.
	MaxInputLen int
	// UserDictPath points at a newline-delimited user word list stacked on top
	// of the curated dictionary (blank/'#' lines ignored). Empty = curated only.
	// When set, the file is watched and the LintGroup hot-reloaded on change.
	UserDictPath string
}

// Harper is a process-wide Corrector. Construct once via New/NewWithOptions;
// safe for serial use. When opts.UserDictPath is set, a background goroutine
// watches the file and rebuilds the cached LintGroup on change (under h.mu).
type Harper struct {
	mu  sync.Mutex
	grp *C.LintGroup
	// dict is the merged-dictionary handle backing both grp AND per-request
	// documents when a user dictionary is configured (nil for curated-only). The
	// document MUST be parsed with the same dictionary as the group or
	// user-dictionary words are not recognised (harper-core assigns word
	// metadata at parse time). Swapped under mu on hot-reload alongside grp.
	dict *C.MergedDict
	opts Options
	// done stops the user-dictionary watcher; closed once by Close via stopOnce.
	// nil (and stopOnce unused) when no watcher is running (no UserDictPath).
	done     chan struct{}
	stopOnce sync.Once
	// pollInterval is the user-dictionary watcher's poll period, captured at
	// construction (defaultUserDictPollInterval; tests may shorten it) so the
	// watcher never reads a shared mutable global.
	pollInterval time.Duration
}

// New builds a Harper with Markdown parsing enabled (the default). It builds the
// cached LintGroup (parses the curated dictionary, ~260ms once).
func New() *Harper { return NewWithOptions(Options{Markdown: true}) }

// NewWithOptions builds a Harper with the given options. The cached LintGroup is
// built for opts.Dialect (with the user dictionary stacked on top when
// opts.UserDictPath is set), then per-rule overrides are applied (disabled
// first, then enabled). When a user dictionary is configured, a watcher
// goroutine hot-reloads the group on file change.
func NewWithOptions(opts Options) *Harper {
	return newWithPollInterval(opts, defaultUserDictPollInterval)
}

// newWithPollInterval is NewWithOptions with an explicit watcher poll interval.
// The poll interval is set on the struct BEFORE the watcher goroutine starts so
// the goroutine never races the field. Tests use a short interval; production
// goes through NewWithOptions (the default interval).
func newWithPollInterval(opts Options, pollInterval time.Duration) *Harper {
	grp, dict := buildGroup(opts)
	h := &Harper{grp: grp, dict: dict, opts: opts, pollInterval: pollInterval}
	if opts.UserDictPath != "" {
		h.done = make(chan struct{})
		go h.watchUserDict(h.done)
	}
	return h
}

// buildGroup constructs a LintGroup for the options. When UserDictPath is set it
// builds a merged-dictionary handle (curated + user words), backs the group with
// it, and RETURNS that handle (the caller stores it so per-request documents are
// parsed with the same dictionary — required for user words to be recognised).
// Otherwise it builds a curated-only group for the dialect and returns a nil
// dict handle. Per-rule overrides are applied in both cases (disabled first,
// then enabled).
func buildGroup(opts Options) (*C.LintGroup, *C.MergedDict) {
	var grp *C.LintGroup
	var dict *C.MergedDict
	if opts.UserDictPath != "" {
		cpath := C.CString(opts.UserDictPath)
		dict = C.harper_create_merged_dict(cpath)
		C.free(unsafe.Pointer(cpath))
		grp = C.harper_create_lint_group_from_dict(dict, C.int32_t(opts.Dialect))
	} else {
		grp = C.harper_create_lint_group_with_dialect(C.int32_t(opts.Dialect))
	}
	applyRuleOverrides(grp, opts.DisabledRules, false)
	applyRuleOverrides(grp, opts.EnabledRules, true)
	return grp, dict
}

// applyRuleOverrides toggles each curated rule key on the lint group. Each key
// CString is freed immediately after the call. Unknown keys are harmless
// (harper-core stores the override but it never matches a registered rule).
func applyRuleOverrides(grp *C.LintGroup, keys []string, enabled bool) {
	en := C.int32_t(0)
	if enabled {
		en = 1
	}
	for _, k := range keys {
		ck := C.CString(k)
		C.harper_lint_group_set_rule_enabled(grp, ck, en)
		C.free(unsafe.Pointer(ck))
	}
}

// Close stops the user-dictionary watcher (if any) and frees the LintGroup. The
// watcher is signalled (once) before the group is freed so a reload can never
// race the free; the freed group is nilled under the lock.
func (h *Harper) Close() {
	if h.done != nil {
		h.stopOnce.Do(func() { close(h.done) })
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.grp != nil {
		C.harper_free_lint_group(h.grp)
		h.grp = nil
	}
	if h.dict != nil {
		C.harper_free_merged_dict(h.dict)
		h.dict = nil
	}
}

// Name reports the model tag.
func (h *Harper) Name() correction.Model { return correction.ModelHarper }

// freeCString frees a char* returned by a harper_get_* function. Per harper.h,
// every such function "Returns a newly allocated string that must be freed by
// the caller using free()". The GoString call already copies the bytes; we must
// free the C allocation to avoid leaks.
func freeCString(p *C.char) {
	if p != nil {
		C.free(unsafe.Pointer(p))
	}
}

// Correct returns Harper lints as byte-offset Suggestions. Harper reports CHAR
// (rune) offsets, converted to byte offsets here; the structured suggestion kind
// (replace/insert-after/remove) is read via harper_get_suggestion.
func (h *Harper) Correct(_ context.Context, req correction.Request) ([]correction.Suggestion, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.opts.MaxInputLen > 0 && len(req.Text) > h.opts.MaxInputLen {
		return nil, nil // skip pathologically long inputs (configurable)
	}

	ctext := C.CString(req.Text)
	defer C.free(unsafe.Pointer(ctext))
	// When a user dictionary is configured the document MUST be parsed with the
	// same merged dictionary as the lint group, or user words are still flagged
	// (harper-core assigns word metadata at parse time). Otherwise use the
	// curated document constructors.
	var doc *C.Document
	ignoreLinkTitle := C.int32_t(0)
	if h.opts.IgnoreLinkTitle {
		ignoreLinkTitle = 1
	}
	switch {
	case h.dict != nil && h.opts.Markdown:
		doc = C.harper_create_document_markdown_with_dict(h.dict, ctext, ignoreLinkTitle)
	case h.dict != nil:
		doc = C.harper_create_document_with_dict(h.dict, ctext)
	case h.opts.Markdown:
		doc = C.harper_create_document_markdown(ctext, ignoreLinkTitle)
	default:
		doc = C.harper_create_document(ctext)
	}
	if doc == nil {
		return nil, nil
	}
	defer C.harper_free_document(doc)

	var count C.int32_t
	lints := C.harper_get_lints(doc, h.grp, &count)
	if lints == nil || count == 0 {
		return nil, nil
	}
	defer C.harper_free_lints(lints, count)

	runeToByte := runeOffsetIndex(req.Text)
	textLen := len(req.Text)
	var out []correction.Suggestion
	var kinds []string // LintKind per accepted suggestion, parallel to out
	for i := 0; i < int(count); i++ {
		lint := C.gf_lint_at(lints, C.int32_t(i))

		ckind := C.harper_get_lint_kind(lint)
		kind := C.GoString(ckind)
		freeCString(ckind)
		// Gate style/word-choice/readability enhancements at the source: a
		// grammar corrector must not rewrite already-correct text for style on
		// the default path (SPEC §6 picky-mode may resurface these). This
		// replaces the old "Vocabulary enhancement" message-substring filter.
		if isStyleKind(kind) {
			continue
		}

		var cs, ce C.int32_t
		C.harper_get_lint_range(lint, &cs, &ce)
		span := correction.Span{Start: runeToByte(int(cs)), End: runeToByte(int(ce))}
		if span.Validate(textLen) != nil {
			continue // skip out-of-range spans (defensive)
		}

		cmsg := C.harper_get_lint_message(lint)
		msg := C.GoString(cmsg)
		freeCString(cmsg)

		// Read the first structured suggestion (kind + payload) rather than
		// parsing the human-readable suggestion string. The bridge's edit model
		// is (span, replacement) where Apply does text[:Start]+repl+text[End:],
		// so each Harper suggestion kind maps as:
		//   ReplaceWith -> replace the lint range with the payload
		//   InsertAfter -> a zero-width edit at the range end inserting the payload
		//   Remove      -> replace the lint range with "" (delete)
		// A lint with no suggestion keeps an empty replacement (flag only).
		sugSpan := span
		repl := ""
		var sugKind C.int32_t
		var sugText *C.char
		if C.harper_get_suggestion(lint, 0, &sugKind, &sugText) == 0 {
			payload := ""
			if sugText != nil {
				payload = C.GoString(sugText)
			}
			freeCString(sugText) // NULL-safe: Remove yields a NULL payload
			sugSpan, repl = resolveSuggestionEdit(int(sugKind), payload, span)
		}

		out = append(out, correction.Suggestion{
			Span:        sugSpan,
			Replacement: repl,
			Message:     msg,
			Model:       correction.ModelHarper,
			Confidence:  0.95,
		})
		kinds = append(kinds, kind)
	}
	// Drop dictionary-driven loanword false positives (spelling/capitalisation
	// lints inside a foreign-word context). Style lints were already gated by
	// kind above.
	out = filterLoanwordFalsePositives(req.Text, out, kinds)
	return out, nil
}

// resolveSuggestionEdit maps a Harper structured suggestion (kind + payload) to
// the bridge's (span, replacement) edit model relative to the lint's byte span,
// where Apply does text[:Start]+replacement+text[End:]:
//   - ReplaceWith: replace the lint span with the payload.
//   - InsertAfter: a zero-width edit at the lint span's end inserting the payload.
//   - Remove (and any unknown kind): replace the lint span with "" (delete).
func resolveSuggestionEdit(kind int, payload string, lintSpan correction.Span) (correction.Span, string) {
	switch kind {
	case suggestionReplaceWith:
		return lintSpan, payload
	case suggestionInsertAfter:
		return correction.Span{Start: lintSpan.End, End: lintSpan.End}, payload
	default: // suggestionRemove (or unrecognised): delete the range
		return lintSpan, ""
	}
}

// runeOffsetIndex returns a fn mapping a rune index to a byte offset in s.
// Harper emits CHAR (rune) offsets in lint.range.start/end; the bridge
// contract is BYTE offsets (see correction.Span), so we map per-call.
func runeOffsetIndex(s string) func(int) int {
	offs := make([]int, 0, len(s)+1)
	for i := range s { // i is the byte offset at each rune boundary
		offs = append(offs, i)
	}
	offs = append(offs, len(s))
	return func(r int) int {
		if r < 0 {
			return 0
		}
		if r >= len(offs) {
			return len(s)
		}
		return offs[r]
	}
}
