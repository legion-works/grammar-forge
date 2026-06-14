// Caret-position + scoped-highlight helpers for the Bug 1 "scoped clear on
// edit" path. The caret is the anchor for the edit — only highlights whose
// span ends strictly before the caret survive (their rects are unchanged);
// any span that intersects the caret has reflowed and must be dropped.
//
// Both helpers are PURE (the caret helper is DOM-bound but has no state of
// its own; the keep helper is a pure list transform). They are the public
// surface of the shared "scoped clear" wiring that both orchestrators call
// synchronously on every input event, BEFORE the debounce schedules a check.
import { domPointToFlatOffset } from '@/input/text'
import type { RenderableItem } from '@/lib/pipeline'

/**
 * Return the code-unit offset of `el`'s caret (the field's "I am here"
 * position), or null when the caret is not deterministically resolvable
 * (e.g. some Slate selection states, or no Selection at all). The caller
 * treats null as "clear all highlights" — better a brief blink than a
 * stale underline at the wrong pixel.
 *
 * textarea / input → selectionStart (always a number when the element is
 * a live form control). contenteditable → walk the document Selection
 * through @/input/text's flat-segment walker, the SAME walker getText and
 * applyFix use, so the offset agrees with the apply path's units.
 */
export function getCaretOffset(el: HTMLElement): number | null {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        return el.selectionStart
    }
    const sel = el.ownerDocument.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    if (!el.contains(range.startContainer)) return null
    // Use the START point of the (possibly non-collapsed) selection — the
    // "edit happens here" anchor. A non-collapsed selection is fine: the
    // user is replacing that range, so anything strictly before is safe.
    return domPointToFlatOffset(el, range.startContainer, range.startOffset)
}

/**
 * Pure: return the subset of `specs` whose edit span ends at or before
 * `editOffset`. Rects for surviving spans haven't reflowed (the edit is
 * AFTER them), so the overlay / native highlight layer can keep them as
 * is — no blink, no remeasure. Dropped spans will be repopulated by the
 * debounced re-check that the input event already scheduled.
 *
 * `editOffset === null` (indeterminate caret) returns [] — the caller
 * should clear-all. Keeping the null-handling here means the wiring is a
 * single conditional: `editOffset == null ? [] : keep(specs, editOffset)`.
 *
 * Items are identified by the RenderableItem type — the helper takes the
 * items list (the data) and the orchestrator re-derives HighlightSpec /
 * NativeHighlightItem from the kept items via its existing per-item
 * projectors.
 */
export function keepHighlightsBeforeEdit(
    specs: readonly RenderableItem[],
    editOffset: number | null,
): RenderableItem[] {
    if (editOffset == null) return []
    const out: RenderableItem[] = []
    for (const s of specs) {
        if (s.cuEnd <= editOffset) out.push(s)
    }
    return out
}
