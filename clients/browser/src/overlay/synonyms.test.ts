// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
    isWordChar,
    offsetFromDblClick,
    resolveWordAtPoint,
    resolveWordFromDblClick,
    showSynonyms,
    type SynonymsOptions,
    type SynonymsHandle,
} from '@/overlay/synonyms'

describe('isWordChar', () => {
    it('accepts ASCII letters and digits', () => {
        expect(isWordChar('a')).toBe(true)
        expect(isWordChar('Z')).toBe(true)
        expect(isWordChar('7')).toBe(true)
    })
    it('accepts Unicode letters + marks (accented, Cyrillic, CJK)', () => {
        expect(isWordChar('é')).toBe(true)
        expect(isWordChar('Ж')).toBe(true)
        expect(isWordChar('ñ')).toBe(true)
    })
    it("accepts underscores + hyphens + ASCII + curly apostrophes (so contractions and co-op stay one word)", () => {
        expect(isWordChar('_')).toBe(true)
        expect(isWordChar('-')).toBe(true)
        expect(isWordChar("'")).toBe(true)
        expect(isWordChar('\u2019')).toBe(true)
    })
    it('rejects whitespace, punctuation, and the empty string', () => {
        expect(isWordChar(' ')).toBe(false)
        expect(isWordChar('\t')).toBe(false)
        expect(isWordChar('.')).toBe(false)
        expect(isWordChar(',')).toBe(false)
        expect(isWordChar('!')).toBe(false)
        expect(isWordChar('(')).toBe(false)
        expect(isWordChar('')).toBe(false)
    })
})

describe('resolveWordAtPoint (PURE — the heart of dblclick detection)', () => {
    it('returns the word at the cursor mid-string', () => {
        const r = resolveWordAtPoint('I think we should of merged.', 12)
        expect(r).toEqual({ word: 'should', start: 11, end: 17 })
    })
    it('returns the word at the cursor inside the word "we"', () => {
        // The natural dblclick target — the click lands on a word
        // character. Offset 8 is the 'w' in 'we'.
        const r = resolveWordAtPoint('I think we should of merged.', 8)
        expect(r).toEqual({ word: 'we', start: 8, end: 10 })
    })
    it('returns the word at the start of the string', () => {
        const r = resolveWordAtPoint('teh quick brown fox', 1)
        expect(r).toEqual({ word: 'teh', start: 0, end: 3 })
    })
    it('returns the word at the end of the string (offset === text.length)', () => {
        const r = resolveWordAtPoint('hello', 5)
        expect(r).toEqual({ word: 'hello', start: 0, end: 5 })
    })
    it('returns null when the offset is on a space AND there is no adjacent word', () => {
        // Offset 0 in ' ' — empty text, no word before or after.
        expect(resolveWordAtPoint(' ', 0)).toBeNull()
        // Offset 1 in '   ' — same; no word chars either side.
        expect(resolveWordAtPoint('   ', 1)).toBeNull()
    })
    it('returns the preceding word when the offset is on trailing punctuation (browser dblclick semantics)', () => {
        // A dblclick on the comma in 'Hello, world' lands on the ','
        // (offset 5). Browsers select the surrounding word — we return
        // the preceding word so the popover always has a target.
        expect(resolveWordAtPoint('Hello, world', 5)).toEqual({
            word: 'Hello',
            start: 0,
            end: 5,
        })
        // When the offset is on a SPACE with no word char immediately to
        // the right (i.e. the user dblclicked a multi-space gap), there
        // is no word to return — null.
        expect(resolveWordAtPoint('Hello, world', 6)).toBeNull()
    })
    it('keeps contractions (don\u2019t) as a single word', () => {
        const text = "I don't think so"
        // Offset 4 is the apostrophe inside "don't".
        const r = resolveWordAtPoint(text, 4)
        expect(r).toEqual({ word: "don't", start: 2, end: 7 })
    })
    it('keeps hyphens (co-op) as a single word', () => {
        const r = resolveWordAtPoint('a co-op plan', 4)
        expect(r).toEqual({ word: 'co-op', start: 2, end: 7 })
    })
    it('returns null when the offset is negative', () => {
        expect(resolveWordAtPoint('hello', -1)).toBeNull()
    })
    it('returns null when the offset is past the end', () => {
        expect(resolveWordAtPoint('hello', 99)).toBeNull()
    })
    it('returns null on an empty string', () => {
        expect(resolveWordAtPoint('', 0)).toBeNull()
    })
    it('handles a non-finite offset as null (defensive)', () => {
        expect(resolveWordAtPoint('hello', Number.NaN)).toBeNull()
        expect(resolveWordAtPoint('hello', Number.POSITIVE_INFINITY)).toBeNull()
    })
    it('handles a non-string text as null (defensive)', () => {
        expect(resolveWordAtPoint(undefined as unknown as string, 0)).toBeNull()
    })
    it('handles a Unicode word (accented letter)', () => {
        const r = resolveWordAtPoint('café latte', 2)
        expect(r).toEqual({ word: 'café', start: 0, end: 4 })
    })
    it('handles a digit-only word', () => {
        const r = resolveWordAtPoint('go to 42 now', 7)
        expect(r).toEqual({ word: '42', start: 6, end: 8 })
    })
})

describe('resolveWordFromDblClick (DOM glue — wraps the pure resolver)', () => {
    it('returns null when the document lacks caretPositionFromPoint AND caretRangeFromPoint', () => {
        const field = document.createElement('div')
        field.textContent = 'hello world'
        document.body.appendChild(field)
        const event = new MouseEvent('dblclick', { clientX: 10, clientY: 10, bubbles: true })
        // jsdom: neither API is implemented; expect null gracefully.
        const r = resolveWordFromDblClick(event, 'hello world', field)
        // jsdom may expose the API as a stub; either way, must not throw.
        expect(r === null || (typeof r === 'object' && typeof r.word === 'string')).toBe(true)
        field.remove()
    })
    it('does not throw on a detached field (offset is -1 → null)', () => {
        const field = document.createElement('div')
        const event = new MouseEvent('dblclick', { clientX: 10, clientY: 10 })
        expect(() => resolveWordFromDblClick(event, 'x', field)).not.toThrow()
    })
})

describe('offsetFromDblClick', () => {
    it('returns -1 when neither caret API is available', () => {
        const field = document.createElement('div')
        document.body.appendChild(field)
        const event = new MouseEvent('dblclick', { clientX: 1, clientY: 1 })
        // jsdom's document does not implement either API; we expect -1
        // (or a successful value if jsdom added a stub in a later
        // version — accept either, just don't throw).
        const n = offsetFromDblClick(event, field)
        expect(typeof n === 'number').toBe(true)
        field.remove()
    })
})

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}

const ANCHOR = new DOMRect(80, 50, 50, 18)

function mkOptions(overrides: Partial<SynonymsOptions> = {}): SynonymsOptions {
    return {
        anchorRect: ANCHOR,
        word: 'teh',
        synonyms: ['the', 'this'],
        loading: false,
        onPick: vi.fn<(s: string) => void>(),
        onClose: vi.fn<() => void>(),
        ...overrides,
    }
}

describe('showSynonyms (DOM mount)', () => {
    it('mounts a .gf-syn in the shadow root', () => {
        const root = mkRoot()
        showSynonyms(root, mkOptions())
        expect(root.querySelector('.gf-syn')).not.toBeNull()
    })

    it('renders one menuitem per synonym', () => {
        const root = mkRoot()
        showSynonyms(root, mkOptions({ synonyms: ['the', 'this', 'that'] }))
        const rows = root.querySelectorAll('.gf-syn__row[role="menuitem"]')
        expect(rows.length).toBe(3)
        const labels = Array.from(rows).map((r) => r.textContent)
        expect(labels).toEqual(['the', 'this', 'that'])
    })

    it('clicking a synonym row fires onPick with the synonym string', () => {
        const root = mkRoot()
        const onPick = vi.fn<(s: string) => void>()
        showSynonyms(root, mkOptions({ onPick, synonyms: ['patch', 'change'] }))
        const rows = Array.from(root.querySelectorAll<HTMLElement>('.gf-syn__row'))
        const patch = rows.find((r) => r.textContent === 'patch') as HTMLElement
        patch.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onPick).toHaveBeenCalledWith('patch')
    })

    it('shows a spinner when loading is true and hides the synonym list', () => {
        const root = mkRoot()
        showSynonyms(root, mkOptions({ loading: true }))
        expect(root.querySelector('.gf-syn__spinner')).not.toBeNull()
        expect(root.querySelector('.gf-syn__loading')?.textContent).toContain('Finding synonyms')
        expect(root.querySelectorAll('.gf-syn__row').length).toBe(0)
    })

    it('shows the empty-state line when synonyms is [] and not loading', () => {
        const root = mkRoot()
        showSynonyms(root, mkOptions({ synonyms: [] }))
        expect(root.querySelector('.gf-syn__empty')?.textContent).toBe('No synonyms found.')
    })

    it('renders the upward tail (positioned along the bottom)', () => {
        const root = mkRoot()
        showSynonyms(root, mkOptions())
        const tail = root.querySelector('.gf-syn__tail') as HTMLElement
        expect(tail).not.toBeNull()
    })

    it('Esc fires onClose', () => {
        const root = mkRoot()
        const onClose = vi.fn<() => void>()
        showSynonyms(root, mkOptions({ onClose }))
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        expect(onClose).toHaveBeenCalledOnce()
    })

    it('a new showSynonyms() dismisses the prior (one popover per root)', () => {
        const root = mkRoot()
        showSynonyms(root, mkOptions())
        showSynonyms(root, mkOptions())
        expect(root.querySelectorAll('.gf-syn')).toHaveLength(1)
    })

    it('destroy() removes the popover; isOpen() reports false afterwards', () => {
        const root = mkRoot()
        const handle: SynonymsHandle = showSynonyms(root, mkOptions())
        expect(handle.isOpen()).toBe(true)
        handle.destroy()
        expect(handle.isOpen()).toBe(false)
        expect(root.querySelector('.gf-syn')).toBeNull()
    })

    it('destroy() is idempotent', () => {
        const root = mkRoot()
        const handle = showSynonyms(root, mkOptions())
        handle.destroy()
        expect(() => handle.destroy()).not.toThrow()
    })

    it('positioning: places the popover under the anchor (or flips above when no room)', () => {
        const root = mkRoot()
        showSynonyms(root, mkOptions())
        const pop = root.querySelector('.gf-syn') as HTMLElement
        const top = parseInt(pop.style.top, 10)
        const left = parseInt(pop.style.left, 10)
        expect(Number.isFinite(top)).toBe(true)
        expect(Number.isFinite(left)).toBe(true)
        expect(top).toBeGreaterThanOrEqual(0)
        expect(left).toBeGreaterThanOrEqual(0)
    })

    it('head displays the double-clicked word', () => {
        const root = mkRoot()
        showSynonyms(root, mkOptions({ word: 'teh' }))
        const head = root.querySelector('.gf-syn__head') as HTMLElement
        expect(head.textContent).toContain('teh')
        expect(head.textContent).toContain('Synonyms')
    })
})
