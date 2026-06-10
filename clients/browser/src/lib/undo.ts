// Single-level Undo bookkeeping for applied corrections. Pure data math —
// the orchestrator owns the DOM (applyFix) and the per-field slot. Spans are
// UTF-16 code units on the field's flattened text, the same model applyFix
// uses.

/** One applied edit, inverted: the POST-apply span, the text that now
 *  occupies it (`applied`, the stale-guard), and the original to restore. */
export interface InverseEdit {
    start: number
    end: number
    applied: string
    original: string
}

/** A single undo operation for the orchestrator to feed into applyFix. */
export interface UndoOp {
    span: { start: number; end: number }
    replacement: string
}

/**
 * Record one apply into a batch. Applies happen LAST-TO-FIRST (descending
 * start, the applyAllFor order), so every edit recorded EARLIER sits at a
 * HIGHER position than the new one and must shift by the new edit's length
 * delta. Returns a new array (caller owns the FieldState slot).
 */
export function appendInverseEdit(
    batch: readonly InverseEdit[],
    edit: { start: number; end: number; replacement: string; original: string },
): InverseEdit[] {
    const delta = edit.replacement.length - (edit.end - edit.start)
    const shifted = batch.map((b) =>
        b.start >= edit.start ? { ...b, start: b.start + delta, end: b.end + delta } : { ...b },
    )
    shifted.push({
        start: edit.start,
        end: edit.start + edit.replacement.length,
        applied: edit.replacement,
        original: edit.original,
    })
    return shifted
}

/**
 * Plan the undo of a recorded batch against the LIVE text: highest start
 * first (undoing above never shifts spans below), each op only when the live
 * slice still equals what was applied (the user may have edited over it).
 */
export function planUndo(live: string, batch: readonly InverseEdit[]): UndoOp[] {
    const ordered = [...batch].sort((a, b) => b.start - a.start)
    const ops: UndoOp[] = []
    for (const b of ordered) {
        if (live.slice(b.start, b.end) !== b.applied) continue
        ops.push({ span: { start: b.start, end: b.end }, replacement: b.original })
    }
    return ops
}
