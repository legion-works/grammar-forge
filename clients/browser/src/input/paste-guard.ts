// Browser-extension-specific input gating. Vencord/OpenCode skip pasted text
// unconditionally; we deliberately diverge — pastes ARE checked by default
// (most browser content IS pasted/AI-generated). The user can opt out via
// `checkPastedText`. Undo/redo always re-check (text changed), independent of
// the paste toggle.

const PASTE_TYPES: ReadonlySet<string> = new Set([
    'insertFromPaste',
    'insertFromPasteAsQuotation',
    'insertFromDrop',
    'insertFromYank',
])

/**
 * Decide whether an `input` (or `beforeinput`) event's `inputType` should
 * trigger a grammar check. The browser client runs live on every keystroke; we
 * must skip bulk paste/drop/yank when the user has opted out, but undo/redo
 * always re-check because the text content actually changed.
 *
 * NOTE: the dataTransfer/large-delta paste heuristic (e.g. >N chars from
 * `application/grammar-ignore` source, or a clipboard payload that's already
 * been AI-generated) lives at the content-script wiring where the full
 * InputEvent is available. This function is intentionally minimal — empty
 * / missing inputType falls through to a "check it" safe default (a missed
 * check is silent; a spurious check is a fast no-op for the caller's own
 * guard).
 */
export function shouldCheckInput(inputType: string, opts: { checkPastedText: boolean }): boolean {
    // Safe default: empty / missing inputType → check.
    if (!inputType) return true
    if (inputType === 'historyUndo' || inputType === 'historyRedo') return true
    if (!opts.checkPastedText && PASTE_TYPES.has(inputType)) return false
    return true
}
