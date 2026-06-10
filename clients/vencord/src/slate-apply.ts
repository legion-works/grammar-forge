// Slate-aware replacement for the browser client's synchronous applyFix on
// Discord's composer.
//
// WHY (root-caused live in Vesktop, 2026-06-10): applyFix sets the DOM
// selection and SYNCHRONOUSLY fires execCommand('insertText'). Two problems
// in a Slate editor:
//   1. At popover-Apply time the composer is NOT focused (the popover stole
//      focus). Slate ignores DOM selection changes while its editor is
//      unfocused, so its MODEL selection never moves to the target range.
//   2. Even when focused, Slate learns about DOM selection changes from the
//      async `selectionchange` task — a synchronous insertText beats it.
// The text itself still lands (Slate handles the beforeinput via target
// ranges), but Slate's internal selection state diverges from the DOM and
// STAYS diverged: afterwards, clicking at the end of the text snaps the
// caret back to the stale model position. The broken state survives plugin
// disable and only resets on a composer remount.
//
// FIX: focus the editor first, set the DOM selection, yield ONE macrotask so
// Slate's selectionchange handler syncs the model, THEN insertText — which
// Slate now applies against the correct model selection, keeping model and
// DOM in lockstep.
import { codeUnitSpanToRange, type CodeUnitSpan } from '@/input/text'

/** One macrotask: `selectionchange` is dispatched as a queued task, so a
 *  setTimeout(0) scheduled AFTER the selection mutation runs after Slate's
 *  handler has seen it. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Apply `replacement` over `span` (flat code-unit offsets, the same model
 * getText uses) in a Slate-managed contenteditable. Async on purpose — the
 * macrotask yield between selection and insertText is the load-bearing part.
 * Returns false when the span cannot be resolved to a DOM range (stale text);
 * callers should re-check instead of applying.
 */
export async function applySlateFix(
    el: HTMLElement,
    span: CodeUnitSpan,
    replacement: string,
): Promise<boolean> {
    const sel = el.ownerDocument.getSelection()
    if (!sel) return false
    const range = codeUnitSpanToRange(el, span)
    if (!range) return false
    // Focus BEFORE selecting: Slate's onDOMSelectionChange ignores selection
    // changes while the editor is unfocused (the popover-Apply case).
    el.focus()
    sel.removeAllRanges()
    sel.addRange(range)
    await settle()
    el.ownerDocument.execCommand('insertText', false, replacement)
    return true
}
