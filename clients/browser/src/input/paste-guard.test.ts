import { describe, expect, it } from 'vitest'
import { shouldCheckInput } from '@/input/paste-guard'

describe('shouldCheckInput', () => {
    it('checks normal typing', () => {
        expect(shouldCheckInput('insertText', { checkPastedText: true })).toBe(true)
    })

    it('checks paste when checkPastedText is true (browser default)', () => {
        expect(shouldCheckInput('insertFromPaste', { checkPastedText: true })).toBe(true)
        expect(shouldCheckInput('insertFromPasteAsQuotation', { checkPastedText: true })).toBe(true)
    })

    it('skips paste / drop / yank when checkPastedText is false', () => {
        expect(shouldCheckInput('insertFromPaste', { checkPastedText: false })).toBe(false)
        expect(shouldCheckInput('insertFromPasteAsQuotation', { checkPastedText: false })).toBe(
            false,
        )
        expect(shouldCheckInput('insertFromDrop', { checkPastedText: false })).toBe(false)
        expect(shouldCheckInput('insertFromYank', { checkPastedText: false })).toBe(false)
    })

    it('still checks paste when checkPastedText is true (explicit)', () => {
        // sanity: positive control next to the negative-control test above
        expect(shouldCheckInput('insertFromDrop', { checkPastedText: true })).toBe(true)
    })

    it('always re-checks undo/redo regardless of checkPastedText', () => {
        expect(shouldCheckInput('historyUndo', { checkPastedText: false })).toBe(true)
        expect(shouldCheckInput('historyRedo', { checkPastedText: false })).toBe(true)
        expect(shouldCheckInput('historyUndo', { checkPastedText: true })).toBe(true)
        expect(shouldCheckInput('historyRedo', { checkPastedText: true })).toBe(true)
    })

    it('checks deletions (text content changed)', () => {
        expect(shouldCheckInput('deleteContentBackward', { checkPastedText: true })).toBe(true)
        expect(shouldCheckInput('deleteContentForward', { checkPastedText: true })).toBe(true)
    })

    it('safe default: empty / missing inputType still triggers a check', () => {
        // We can't infer the type from an empty string or undefined — better
        // to over-check (a missed check is silent; a spurious check is a fast
        // no-op for the caller's own guard). The full dataTransfer/large-delta
        // paste heuristic lives at the content-script wiring where the full
        // InputEvent is available; this function is intentionally minimal.
        expect(shouldCheckInput('', { checkPastedText: true })).toBe(true)
        expect(shouldCheckInput('', { checkPastedText: false })).toBe(true)
        // @ts-expect-error: undefined is permitted at runtime even though the
        // public type is `string` — we keep the type narrow and tolerate
        // undefined for the safe-default contract.
        expect(shouldCheckInput(undefined, { checkPastedText: false })).toBe(true)
    })
})
