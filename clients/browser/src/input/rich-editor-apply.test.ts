// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applySlateFix, isFrameworkRichEditor, widenInsertion } from './rich-editor-apply'

describe('widenInsertion', () => {
    it('passes non-collapsed spans through unchanged', () => {
        const r = widenInsertion('abcdef', { start: 1, end: 3 }, 'X')
        expect(r).toEqual({ span: { start: 1, end: 3 }, replacement: 'X' })
    })
    it('widens a mid-text insertion onto the preceding char', () => {
        // insert "." at end-of-word: replace "e" -> "e."
        const r = widenInsertion('apple', { start: 5, end: 5 }, '.')
        expect(r).toEqual({ span: { start: 4, end: 5 }, replacement: 'e.' })
    })
    it('widens an offset-0 insertion onto the following char', () => {
        const r = widenInsertion('bc', { start: 0, end: 0 }, 'a')
        expect(r).toEqual({ span: { start: 0, end: 1 }, replacement: 'ab' })
    })
    it('keeps surrogate pairs whole when widening left', () => {
        const text = 'a\u{1F600}' // 'a' + emoji (2 code units), insert after emoji
        const r = widenInsertion(text, { start: 3, end: 3 }, '!')
        expect(r.span).toEqual({ start: 1, end: 3 })
        expect(r.replacement).toBe('\u{1F600}!')
    })
    it('keeps surrogate pairs whole when widening right at offset 0', () => {
        const text = '\u{1F600}b'
        const r = widenInsertion(text, { start: 0, end: 0 }, '!')
        expect(r.span).toEqual({ start: 0, end: 2 })
        expect(r.replacement).toBe('!\u{1F600}')
    })
    it('returns collapsed span unchanged on empty text', () => {
        const r = widenInsertion('', { start: 0, end: 0 }, 'x')
        expect(r).toEqual({ span: { start: 0, end: 0 }, replacement: 'x' })
    })
})

const mkCE = (text: string): HTMLDivElement => {
    const d = document.createElement('div')
    d.setAttribute('contenteditable', 'true')
    d.textContent = text
    document.body.appendChild(d)
    return d
}

describe('applySlateFix — success/failure verification (P0-1)', () => {
    let originalExec: typeof document.execCommand

    beforeEach(() => {
        vi.useFakeTimers()
        originalExec = document.execCommand
    })
    afterEach(() => {
        document.execCommand = originalExec
        vi.useRealTimers()
    })

    it('returns true when the editor asynchronously commits the exact expected text (no fallback invoked)', async () => {
        const el = mkCE('hello wrold')
        const execSpy = vi.fn<() => boolean>(() => true)
        document.execCommand = execSpy
        el.addEventListener('beforeinput', () => {
            setTimeout(() => {
                el.textContent = 'hello world'
            }, 10)
        })

        const promise = applySlateFix(el, { start: 6, end: 11 }, 'world')
        await vi.advanceTimersByTimeAsync(60)
        const result = await promise

        expect(result).toBe(true)
        expect(execSpy).not.toHaveBeenCalled()
    })

    it('returns false when an unrelated keystroke lands during the poll window (does NOT count as success, no fallback)', async () => {
        const el = mkCE('hello wrold')
        const execSpy = vi.fn<() => boolean>(() => true)
        document.execCommand = execSpy
        // Simulate a user keystroke elsewhere in the field shortly after our
        // synthetic beforeinput — unrelated to the replacement text.
        el.addEventListener('beforeinput', () => {
            setTimeout(() => {
                el.textContent = 'hello wrold!'
            }, 10)
        })

        const promise = applySlateFix(el, { start: 6, end: 11 }, 'world')
        await vi.advanceTimersByTimeAsync(60)
        const result = await promise

        expect(result).toBe(false)
        expect(execSpy).not.toHaveBeenCalled()
    })

    it('returns true via the legacy fallback only when execCommand actually lands the replacement', async () => {
        const el = mkCE('hello wrold')
        // The editor never consumes the synthetic beforeinput (poll window
        // expires with no change), so the legacy execCommand fallback runs.
        // Simulate a real host that actually performs the insertion.
        document.execCommand = vi.fn<typeof document.execCommand>((cmd: string) => {
            if (cmd === 'insertText') el.textContent = 'hello world'
            return true
        })

        const promise = applySlateFix(el, { start: 6, end: 11 }, 'world')
        await vi.advanceTimersByTimeAsync(1000)
        const result = await promise

        expect(result).toBe(true)
    })

    it('returns false via the legacy fallback when execCommand reports success but nothing actually changed (the original unconditional-true bug)', async () => {
        const el = mkCE('hello wrold')
        // execCommand "succeeds" (returns true, as jsdom / some hosts do)
        // but never mutates the DOM — the historical bug returned true here
        // regardless.
        document.execCommand = vi.fn<typeof document.execCommand>(() => true)

        const promise = applySlateFix(el, { start: 6, end: 11 }, 'world')
        await vi.advanceTimersByTimeAsync(1000)
        const result = await promise

        expect(result).toBe(false)
    })
})

describe('isFrameworkRichEditor', () => {
    it('returns true when el itself carries data-slate-editor', () => {
        const el = document.createElement('div')
        el.setAttribute('data-slate-editor', '')
        document.body.appendChild(el)
        expect(isFrameworkRichEditor(el)).toBe(true)
    })
    it('returns true when an ancestor carries data-slate-editor (closest)', () => {
        const root = document.createElement('div')
        root.setAttribute('data-slate-editor', '')
        const child = document.createElement('div')
        root.appendChild(child)
        document.body.appendChild(root)
        // the descendant child sees the attr on its ancestor
        expect(isFrameworkRichEditor(child)).toBe(true)
    })
    it('returns true when a descendant carries data-lexical-editor (querySelector)', () => {
        const root = document.createElement('div')
        const inner = document.createElement('div')
        inner.setAttribute('data-lexical-editor', '')
        root.appendChild(inner)
        document.body.appendChild(root)
        // the wrapping contenteditable (the field we apply to) does NOT
        // itself carry the attr — but the editor root sits INSIDE it.
        expect(isFrameworkRichEditor(root)).toBe(true)
    })
    it('returns false on a plain contenteditable (no framework attr anywhere)', () => {
        const el = document.createElement('div')
        el.setAttribute('contenteditable', 'true')
        document.body.appendChild(el)
        expect(isFrameworkRichEditor(el)).toBe(false)
    })
})
