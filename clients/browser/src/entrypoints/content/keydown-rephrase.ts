// clients/browser/src/entrypoints/content/keydown-rephrase.ts
// The browser-content rephrase-hotkey branch, extracted as a small pure
// helper so the matching + side-effect path is testable without spinning
// up the full orchestrator. The onKeydown handler in index.ts calls
// this BEFORE the accept branch.

import { shouldRephraseHotkey } from '@/hotkeys/rephrase-target'

export interface HandleRephraseHotkeyCtx {
    hotkey: string
    rephraseFor: (field: HTMLElement) => void
    field: HTMLElement | null
}

/** Returns true iff the handler matched the chord and acted on it (so
 *  the caller can short-circuit further branches). `shouldRephraseHotkey`
 *  swallows `parseHotkey` errors — a malformed configured string returns
 *  false instead of throwing. */
export function handleRephraseHotkey(event: KeyboardEvent, ctx: HandleRephraseHotkeyCtx): boolean {
    if (!ctx.field) return false
    const matched = shouldRephraseHotkey(event, { hotkey: ctx.hotkey })
    if (!matched) return false
    event.preventDefault()
    event.stopPropagation()
    ctx.rephraseFor(ctx.field)
    return true
}
