// clients/browser/src/hotkeys/rephrase-target.test.ts
// Pure unit tests for the shared rephrase-target decision. Both DOM
// clients (browser, Vencord) route their rephrase flow through these
// functions; the wire-up lives in their respective orchestrators.
import { describe, expect, it } from 'vitest'
import {
    selectRephraseTarget,
    shouldRephraseHotkey,
    type RephraseSelection,
} from '@/hotkeys/rephrase-target'
import type { HotkeyEvent } from '@/hotkeys/accept'

function keyEvent(overrides: Partial<HotkeyEvent>): HotkeyEvent {
    return {
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        key: '',
        code: '',
        ...overrides,
    }
}

describe('selectRephraseTarget', () => {
    it('uses the selection when it matches the current element', () => {
        const sel: RephraseSelection = { el: 'A', text: 'sel', span: { start: 0, end: 3 } }
        const out = selectRephraseTarget({
            selection: sel,
            currentEl: 'A',
            wholeText: 'sel whole',
        })
        expect(out).toEqual({ text: 'sel', span: { start: 0, end: 3 } })
    })

    it('falls back to whole text when the selection is for a different field', () => {
        const sel: RephraseSelection = { el: 'A', text: 'sel', span: { start: 0, end: 3 } }
        const out = selectRephraseTarget({
            selection: sel,
            currentEl: 'B',
            wholeText: 'whole',
        })
        expect(out).toEqual({ text: 'whole', span: { start: 0, end: 5 } })
    })

    it('uses whole text when no selection exists', () => {
        const out = selectRephraseTarget({
            selection: null,
            currentEl: 'A',
            wholeText: 'hello world',
        })
        expect(out).toEqual({ text: 'hello world', span: { start: 0, end: 11 } })
    })

    it('returns null for a whitespace-only whole field (nothing to rephrase)', () => {
        const out = selectRephraseTarget({
            selection: null,
            currentEl: 'A',
            wholeText: '   \n\t  ',
        })
        expect(out).toBeNull()
    })
})

describe('shouldRephraseHotkey', () => {
    it('matches Ctrl+/ against "Ctrl+/"', () => {
        expect(
            shouldRephraseHotkey(keyEvent({ ctrlKey: true, key: '/' }), { hotkey: 'Ctrl+/' }),
        ).toBe(true)
    })

    it('does NOT match Ctrl+. (the accept chord) when the hotkey is Ctrl+/', () => {
        expect(
            shouldRephraseHotkey(keyEvent({ ctrlKey: true, key: '.' }), { hotkey: 'Ctrl+/' }),
        ).toBe(false)
    })

    it('does NOT match "/" without a modifier', () => {
        expect(shouldRephraseHotkey(keyEvent({ key: '/' }), { hotkey: 'Ctrl+/' })).toBe(false)
    })

    it('does NOT throw and returns false for a malformed configured hotkey', () => {
        expect(
            shouldRephraseHotkey(keyEvent({ ctrlKey: true, key: '/' }), { hotkey: 'not-a-chord' }),
        ).toBe(false)
    })
})
