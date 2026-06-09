// Detect an undo/redo keyboard chord. Rich editors (Discord/Lexical, Slack,
// Google Docs) implement their OWN history: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z are
// intercepted and applied PROGRAMMATICALLY via the editor's reconciler, which
// does NOT emit a native `input` event with inputType='historyUndo'/'historyRedo'.
// So an `input`-only listener never sees undo/redo in those editors. The content
// orchestrator listens for the chord directly (capture phase, never
// preventing default) and re-checks after the editor reconciles.
//
// Pure predicate (no DOM) so it can be unit-tested. Matches both Ctrl (Win/Linux)
// and Meta (macOS). Redo is Ctrl+Y OR Ctrl+Shift+Z (both conventions).

/** The KeyboardEvent fields the chord test needs. */
export interface KeyChord {
    key: string
    ctrlKey: boolean
    metaKey: boolean
    shiftKey: boolean
}

/** True for an undo chord: (Ctrl|Cmd)+Z without Shift. */
export function isUndoKeydown(e: KeyChord): boolean {
    if (!(e.ctrlKey || e.metaKey)) return false
    if (e.shiftKey) return false
    return e.key.toLowerCase() === 'z'
}

/** True for a redo chord: (Ctrl|Cmd)+Y, or (Ctrl|Cmd)+Shift+Z. */
export function isRedoKeydown(e: KeyChord): boolean {
    if (!(e.ctrlKey || e.metaKey)) return false
    const key = e.key.toLowerCase()
    if (key === 'y' && !e.shiftKey) return true
    if (key === 'z' && e.shiftKey) return true
    return false
}

/** True for either an undo or a redo chord. */
export function isUndoRedoKeydown(e: KeyChord): boolean {
    return isUndoKeydown(e) || isRedoKeydown(e)
}
