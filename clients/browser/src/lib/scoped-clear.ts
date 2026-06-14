// clients/browser/src/lib/scoped-clear.ts
// The overlay side of applyScopedClearToField, extracted so the
// null-caret short-circuit (Finding 5) is testable in isolation.
// Both orchestrators (browser content/index.ts and Vencord
// orchestrator.ts) call this with their closure-captured highlight
// layer + the old/kept item lists.

export interface ClearableHighlightLayer {
    /** Hide the pooled highlight nodes for the OLD item at `index` (by
     *  data-item lookup; the old index → node mapping is irrelevant). */
    clearItem(index: number): void
    /** Wholesale reconcile — pass [] to hide every highlight on the field. */
    reconcile(specs: readonly never[]): void
}

/** Apply a scoped clear to an overlay highlight layer.
 *  - `oldItems.length === kept.length` → no-op (caller should have bailed).
 *  - `kept.length === 0` → fast clear-all via `reconcile([])` (O(pool)
 *    instead of O(N × pool) on the per-item loop; Finding 5).
 *  - Otherwise → iterate old items, hide the ones not in `kept`.
 *
 *  The `kept` membership test uses reference equality on items (the
 *  orchestrator's `keepHighlightsBeforeEdit` returns a sliced subset
 *  of the OLD items, so identity is preserved). */
export function applyScopedOverlayClear<L extends ClearableHighlightLayer, I>(
    layer: L,
    oldItems: readonly I[],
    kept: readonly I[],
): void {
    if (oldItems.length === kept.length) return
    if (kept.length === 0) {
        // Finding 5: null-caret (or any edit-offset-unknown) clear-all
        // path. The per-item loop below is O(N × pool); `reconcile([])`
        // is O(pool). Same semantic: hide every highlight on the field.
        layer.reconcile([])
        return
    }
    const keptSet = new Set(kept)
    for (let i = 0; i < oldItems.length; i++) {
        if (!keptSet.has(oldItems[i]!)) {
            layer.clearItem(i)
        }
    }
}
