// clients/browser/src/hotkeys/rephrase-target.ts
// Shared rephrase decision used by both DOM clients. selectRephraseTarget
// is the pure scope decision (selection-in-el or whole-field). shouldRephraseHotkey
// is the chord matcher (delegates to parseHotkey/matchesHotkey from ./accept;
// wraps in try/catch so a malformed configured string can't crash the
// keydown listener). No new parser, no new matcher.

import { matchesHotkey, parseHotkey, type HotkeyEvent } from './accept'

/** A non-empty selection scoped to a specific element. `el` is the element
 *  the selection is for; `text` is the selected text; `span` is the
 *  code-unit span inside `el`. The DOM clients resolve this from the
 *  current Selection or the field's selectionStart/End before calling. */
export interface RephraseSelection {
    el: HTMLElement | string
    text: string
    span: { start: number; end: number }
}

export interface SelectRephraseTargetInput {
    selection: RephraseSelection | null
    currentEl: HTMLElement | string
    wholeText: string
}

/** Pure: pick the rephrase target. Selection wins when its `el` matches
 *  `currentEl`; otherwise fall back to the whole field. A whitespace-only
 *  whole field returns null so the caller can no-op. */
export function selectRephraseTarget(
    input: SelectRephraseTargetInput,
): { text: string; span: { start: number; end: number } } | null {
    if (input.selection && input.selection.el === input.currentEl) {
        return { text: input.selection.text, span: input.selection.span }
    }
    const text = input.wholeText
    if (!text.trim()) return null
    return { text, span: { start: 0, end: text.length } }
}

export interface ShouldRephraseHotkeyOptions {
    hotkey: string
}

/** Decide whether `event` should trigger the rephrase action. Unlike the
 *  accept hotkey, the rephrase hotkey does NOT require active suggestions
 *  — it fires whenever a tracked field is focused. A malformed
 *  configured string returns false (does not throw) so a broken setting
 *  can't turn every keystroke into an uncaught error. */
export function shouldRephraseHotkey(
    event: HotkeyEvent,
    opts: ShouldRephraseHotkeyOptions,
): boolean {
    try {
        return matchesHotkey(event, parseHotkey(opts.hotkey))
    } catch {
        return false
    }
}
