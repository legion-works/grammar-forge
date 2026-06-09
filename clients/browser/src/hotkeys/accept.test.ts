import { describe, expect, it } from 'vitest'
import { matchesHotkey, parseHotkey, shouldAcceptHotkey, type HotkeyEvent } from '@/hotkeys/accept'

function keyEvent(overrides: Partial<HotkeyEvent>): HotkeyEvent {
    return {
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        key: '',
        ...overrides,
    }
}

describe('parseHotkey', () => {
    it('parses "Ctrl+." into a Ctrl combo on key "."', () => {
        expect(parseHotkey('Ctrl+.')).toEqual({
            ctrl: true,
            shift: false,
            alt: false,
            meta: false,
            key: '.',
        })
    })

    it('parses "Cmd+." (mac alias) and treats Cmd as ctrl OR meta', () => {
        // Both spellings map to the same flag set so the matcher is cross-OS.
        expect(parseHotkey('Cmd+.')).toEqual({
            ctrl: true,
            shift: false,
            alt: false,
            meta: true,
            key: '.',
        })
    })

    it('parses "Ctrl+Shift+Period" with a non-punctuation name', () => {
        expect(parseHotkey('Ctrl+Shift+Period')).toEqual({
            ctrl: true,
            shift: true,
            alt: false,
            meta: false,
            key: 'period',
        })
    })

    it('parses "Alt+Shift+x" case-insensitively', () => {
        expect(parseHotkey('alt+SHIFT+X')).toEqual({
            ctrl: false,
            shift: true,
            alt: true,
            meta: false,
            key: 'x',
        })
    })

    it('throws on an empty string', () => {
        expect(() => parseHotkey('')).toThrow(/empty/)
    })

    it('throws on a bare letter (no modifier)', () => {
        // The accept hotkey is a chord; a lone letter would hijack typing.
        expect(() => parseHotkey('a')).toThrow(/modifier/)
    })
})

describe('matchesHotkey', () => {
    const parsed = parseHotkey('Ctrl+.')

    it('matches Ctrl+. (no Shift/Alt)', () => {
        expect(matchesHotkey(keyEvent({ ctrlKey: true, key: '.' }), parsed)).toBe(true)
    })

    it('matches Cmd+. on mac (metaKey) — cross-OS', () => {
        expect(matchesHotkey(keyEvent({ metaKey: true, key: '.' }), parsed)).toBe(true)
    })

    it('rejects when the wrong key is pressed', () => {
        expect(matchesHotkey(keyEvent({ ctrlKey: true, key: ',' }), parsed)).toBe(false)
    })

    it('rejects when no modifier is held', () => {
        expect(matchesHotkey(keyEvent({ key: '.' }), parsed)).toBe(false)
    })

    it('rejects when the parsed combo required Shift but it is not held', () => {
        const shiftParsed = parseHotkey('Ctrl+Shift+Period')
        expect(matchesHotkey(keyEvent({ ctrlKey: true, key: 'Period' }), shiftParsed)).toBe(false)
    })

    it('treats the configured key case-insensitively', () => {
        const parsedZ = parseHotkey('Ctrl+Z')
        expect(matchesHotkey(keyEvent({ ctrlKey: true, key: 'z' }), parsedZ)).toBe(true)
        expect(matchesHotkey(keyEvent({ ctrlKey: true, key: 'Z' }), parsedZ)).toBe(true)
    })
})

describe('shouldAcceptHotkey', () => {
    it('fires for Ctrl+. when a suggestion is active', () => {
        expect(
            shouldAcceptHotkey(keyEvent({ ctrlKey: true, key: '.' }), {
                hotkey: 'Ctrl+.',
                hasActiveSuggestion: true,
            }),
        ).toBe(true)
    })

    it('does NOT fire for Ctrl+. when no suggestion is active (passthrough)', () => {
        // Without an active suggestion, the hotkey must NOT hijack the field —
        // Tab, normal typing, and other key combos must pass through untouched.
        expect(
            shouldAcceptHotkey(keyEvent({ ctrlKey: true, key: '.' }), {
                hotkey: 'Ctrl+.',
                hasActiveSuggestion: false,
            }),
        ).toBe(false)
    })

    it('does not fire for a plain "." keystroke', () => {
        expect(
            shouldAcceptHotkey(keyEvent({ key: '.' }), {
                hotkey: 'Ctrl+.',
                hasActiveSuggestion: true,
            }),
        ).toBe(false)
    })

    it('does not fire for Tab, even with an active suggestion', () => {
        // We never want to swallow Tab; focus nav must survive.
        expect(
            shouldAcceptHotkey(keyEvent({ key: 'Tab' }), {
                hotkey: 'Ctrl+.',
                hasActiveSuggestion: true,
            }),
        ).toBe(false)
    })

    it('fires for Cmd+. on mac when a suggestion is active', () => {
        expect(
            shouldAcceptHotkey(keyEvent({ metaKey: true, key: '.' }), {
                hotkey: 'Ctrl+.',
                hasActiveSuggestion: true,
            }),
        ).toBe(true)
    })

    it('respects a non-default configured hotkey', () => {
        // A different chord must parse + match — no hard-coded "Ctrl+.".
        expect(
            shouldAcceptHotkey(keyEvent({ ctrlKey: true, shiftKey: true, key: 'Enter' }), {
                hotkey: 'Ctrl+Shift+Enter',
                hasActiveSuggestion: true,
            }),
        ).toBe(true)
        // And it must NOT match an active suggestion when the modifier is missing.
        expect(
            shouldAcceptHotkey(keyEvent({ key: 'Enter' }), {
                hotkey: 'Ctrl+Shift+Enter',
                hasActiveSuggestion: true,
            }),
        ).toBe(false)
    })
})
