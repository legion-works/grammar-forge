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
	"regexp"
	"sync"
	"unsafe"

	"github.com/grammarforge/bridge/internal/correction"
)

// Harper is a process-wide Corrector. Construct once via New; safe for serial use.
type Harper struct {
	mu  sync.Mutex
	grp *C.LintGroup
}

// New builds the cached LintGroup (parses the curated dictionary, ~260ms once).
func New() *Harper { return &Harper{grp: C.harper_create_lint_group()} }

// Close frees the LintGroup.
func (h *Harper) Close() {
	if h.grp != nil {
		C.harper_free_lint_group(h.grp)
		h.grp = nil
	}
}

// Name reports the model tag.
func (h *Harper) Name() correction.Model { return correction.ModelHarper }

var replRe = regexp.MustCompile(`^Replace with: "(.*)"$`)

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
// (rune) offsets and pre-formatted suggestion strings; both are converted here.
func (h *Harper) Correct(_ context.Context, req correction.Request) ([]correction.Suggestion, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	ctext := C.CString(req.Text)
	defer C.free(unsafe.Pointer(ctext))
	doc := C.harper_create_document(ctext)
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

		repl := ""
		if n := int(C.harper_get_suggestion_count(lint)); n > 0 {
			csug := C.harper_get_suggestion_text(lint, 0)
			raw := C.GoString(csug)
			freeCString(csug)
			if m := replRe.FindStringSubmatch(raw); m != nil {
				repl = m[1]
			}
		}

		out = append(out, correction.Suggestion{
			Span:        span,
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
