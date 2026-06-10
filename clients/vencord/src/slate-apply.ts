// Slate-aware replacement for the browser client's synchronous applyFix on
// Discord's composer.
//
// WHY (root-caused live in Vesktop, 2026-06-10): any EXTERNAL mutation of the
// DOM selection around Discord's Slate editor can jam Slate's internal
// selection bookkeeping — its model selection diverges from the DOM and is
// re-asserted over every subsequent click (caret "jumps back"; in the worst
// case a stale full-text selection sticks). The first fix attempt
// (focus + select + macrotask settle + execCommand insertText) reduced but
// did not eliminate the desync: the latch can jam regardless of timing.
//
// FIX v2: never touch the DOM selection. Speak the editor's native
// autocorrect protocol instead — a synthetic `beforeinput` with
// `inputType: "insertReplacementText"` and `getTargetRanges()` overridden to
// the target StaticRange. This is exactly how OS spellcheck/autocorrect
// integrates with contenteditable; slate-react consumes the target range and
// applies the replacement through its own model (verified live in Vesktop:
// the synthetic event replaces text and the caret stays sane).
//
// A defensive fallback to the legacy selection+execCommand path remains for
// payloads the editor ignores (e.g. some editors drop empty-data
// replacement events for pure deletions) — detected by comparing the text
// before/after the dispatch.
import { codeUnitSpanToRange, getText, type CodeUnitSpan } from '@/input/text'

/** One macrotask — lets the editor finish reconciling (and, on the fallback
 *  path, lets its `selectionchange` handler observe our selection) before
 *  callers re-read the text. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Apply `replacement` over `span` (flat code-unit offsets, the same model
 * getText uses) in a rich-text contenteditable. Returns false when the span
 * cannot be resolved to a DOM range (stale text); callers should re-check
 * instead of applying.
 */
export async function applySlateFix(
    el: HTMLElement,
    span: CodeUnitSpan,
    replacement: string,
): Promise<boolean> {
    const range = codeUnitSpanToRange(el, span)
    if (!range) return false
    const before = getText(el)
    const expected = before.slice(0, span.start) + replacement + before.slice(span.end)

    const staticRange = new StaticRange({
        startContainer: range.startContainer,
        startOffset: range.startOffset,
        endContainer: range.endContainer,
        endOffset: range.endOffset,
    })
    const event = new InputEvent('beforeinput', {
        inputType: 'insertReplacementText',
        data: replacement,
        bubbles: true,
        cancelable: true,
    })
    // Synthetic InputEvents report no target ranges; the editor's beforeinput
    // handler reads them via this method, so supply our range there.
    Object.defineProperty(event, 'getTargetRanges', { value: () => [staticRange] })
    el.dispatchEvent(event)
    await settle()
    if (getText(el) === expected) return true
    if (getText(el) !== before) {
        // The editor applied SOMETHING (normalisation, smart punctuation…).
        // Treat as applied — every caller re-checks against live text anyway.
        return true
    }

    // Editor ignored the synthetic replacement (seen with empty-data pure
    // deletions in some editors). Legacy path: focus first (selection
    // changes are ignored by Slate while unfocused), select, settle one
    // macrotask so the editor syncs, then insertText.
    const sel = el.ownerDocument.getSelection()
    if (!sel) return false
    el.focus()
    sel.removeAllRanges()
    sel.addRange(range)
    await settle()
    el.ownerDocument.execCommand('insertText', false, replacement)
    return true
}
