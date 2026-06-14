// @vitest-environment jsdom
// clients/browser/src/entrypoints/content/keydown-rephrase.test.ts
// Unit tests for the in-content rephrase-hotkey branch. We extract the
// decision as a small `handleRephraseHotkey(event, ctx)` helper so the
// matching + side-effect path is testable without spinning up the full
// orchestrator. The full onKeydown handler calls this BEFORE the accept
// branch — that ordering is the contract these tests pin.

import { describe, expect, it, vi } from 'vitest'
import { handleRephraseHotkey } from './keydown-rephrase'
import type { HotkeyEvent } from '@/hotkeys/accept'

function keyEvent(
    overrides: Partial<HotkeyEvent> & { preventDefault?: () => void; stopPropagation?: () => void },
): KeyboardEvent {
    const preventDefault = overrides.preventDefault ?? vi.fn<() => void>()
    const stopPropagation = overrides.stopPropagation ?? vi.fn<() => void>()
    const evt = new KeyboardEvent('keydown', {
        ctrlKey: overrides.ctrlKey ?? false,
        shiftKey: overrides.shiftKey ?? false,
        altKey: overrides.altKey ?? false,
        metaKey: overrides.metaKey ?? false,
        key: overrides.key ?? '',
    })
    Object.defineProperty(evt, 'code', { value: overrides.code ?? '', configurable: true })
    vi.spyOn(evt, 'preventDefault').mockImplementation(preventDefault)
    vi.spyOn(evt, 'stopPropagation').mockImplementation(stopPropagation)
    return evt
}

describe('handleRephraseHotkey', () => {
    it('fires rephraseFor + preventDefault + stopPropagation on a matching chord with a focused field', () => {
        const rephraseFor = vi.fn<(field: HTMLElement) => void>()
        const field = document.createElement('textarea')
        const e = keyEvent({ ctrlKey: true, key: '/', code: 'Slash' })
        const result = handleRephraseHotkey(e, { hotkey: 'Ctrl+/', rephraseFor, field })
        expect(result).toBe(true)
        expect(rephraseFor).toHaveBeenCalledWith(field)
        expect(e.preventDefault).toHaveBeenCalledTimes(1)
        expect(e.stopPropagation).toHaveBeenCalledTimes(1)
    })

    it('does NOT fire when there is no focused field (chord passes through)', () => {
        const rephraseFor = vi.fn<(field: HTMLElement) => void>()
        const e = keyEvent({ ctrlKey: true, key: '/', code: 'Slash' })
        const result = handleRephraseHotkey(e, { hotkey: 'Ctrl+/', rephraseFor, field: null })
        expect(result).toBe(false)
        expect(rephraseFor).not.toHaveBeenCalled()
        expect(e.preventDefault).not.toHaveBeenCalled()
    })

    it('does NOT fire on a non-matching chord (e.g. just "/" with no modifier)', () => {
        const rephraseFor = vi.fn<(field: HTMLElement) => void>()
        const field = document.createElement('textarea')
        const e = keyEvent({ key: '/', code: 'Slash' })
        const result = handleRephraseHotkey(e, { hotkey: 'Ctrl+/', rephraseFor, field })
        expect(result).toBe(false)
        expect(rephraseFor).not.toHaveBeenCalled()
        expect(e.preventDefault).not.toHaveBeenCalled()
    })

    it('does NOT throw on a malformed configured hotkey string (returns false)', () => {
        const rephraseFor = vi.fn<(field: HTMLElement) => void>()
        const field = document.createElement('textarea')
        const e = keyEvent({ ctrlKey: true, key: '/', code: 'Slash' })
        expect(() =>
            handleRephraseHotkey(e, { hotkey: 'not-a-chord', rephraseFor, field }),
        ).not.toThrow()
        expect(handleRephraseHotkey(e, { hotkey: 'not-a-chord', rephraseFor, field })).toBe(false)
        expect(rephraseFor).not.toHaveBeenCalled()
    })
})
