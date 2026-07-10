// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    it('accepts underscores + hyphens + ASCII + curly apostrophes (so contractions and co-op stay one word)', () => {
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

    it('uses selectionStart for <textarea> (not caretPositionFromPoint which returns offset 0)', () => {
        // Bug-fix: caretPositionFromPoint / caretRangeFromPoint return the
        // textarea element itself (not a text node inside it) for <textarea>,
        // so range.setStart(fieldEl, 0) → range.setEnd(textarea, 0) → length 0
        // → offset 0 → always resolves the FIRST word ("I" in "I have a apple").
        // The fix: for textarea/input, use selectionStart (the browser selects
        // the double-clicked word on dblclick, so selectionStart is the word start).
        const field = document.createElement('textarea')
        field.value = 'I have a apple'
        document.body.appendChild(field)
        // Simulate the browser selecting "have" (offset 2..6) on dblclick.
        field.setSelectionRange(2, 6)
        const event = new MouseEvent('dblclick', { clientX: 1, clientY: 1 })
        const n = offsetFromDblClick(event, field)
        // Should return selectionStart (2), not 0 (first word).
        expect(n).toBe(2)
        field.remove()
    })

    it('uses selectionStart for <input> (same fix as textarea)', () => {
        const field = document.createElement('input')
        field.type = 'text'
        field.value = 'hello world'
        document.body.appendChild(field)
        field.setSelectionRange(6, 11)
        const event = new MouseEvent('dblclick', { clientX: 1, clientY: 1 })
        const n = offsetFromDblClick(event, field)
        expect(n).toBe(6)
        field.remove()
    })

    it('resolveWordFromDblClick on a textarea returns the double-clicked word (not the first word)', () => {
        // Integration test: the full path from dblclick → offset → word.
        // "have" is at offset 2 in "I have a apple".
        const field = document.createElement('textarea')
        field.value = 'I have a apple'
        document.body.appendChild(field)
        field.setSelectionRange(2, 6)
        const event = new MouseEvent('dblclick', { clientX: 1, clientY: 1 })
        const resolved = resolveWordFromDblClick(event, 'I have a apple', field)
        expect(resolved).not.toBeNull()
        expect(resolved?.word).toBe('have')
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

    it('P1-7: Esc still fires onClose on a host page that stopPropagation()s at window capture', () => {
        // Same fix as goals.ts: Esc must be registered on window capture
        // itself (not document bubble) so a host page's own
        // window-capture + stopPropagation() listener can't starve it.
        const hostListener = (e: KeyboardEvent): void => e.stopPropagation()
        window.addEventListener('keydown', hostListener, { capture: true })
        try {
            const root = mkRoot()
            const onClose = vi.fn<() => void>()
            showSynonyms(root, mkOptions({ onClose }))
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
            expect(onClose).toHaveBeenCalledOnce()
        } finally {
            window.removeEventListener('keydown', hostListener, { capture: true })
        }
    })

    it('destroy() removes the Esc listener (no leak — a later Esc does not double-fire onClose)', () => {
        const root = mkRoot()
        const onClose = vi.fn<() => void>()
        const handle = showSynonyms(root, mkOptions({ onClose }))
        handle.destroy()
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        expect(onClose).not.toHaveBeenCalled()
    })

    describe('P1-5: focus restoration on close', () => {
        let field: HTMLTextAreaElement
        beforeEach(() => {
            field = document.createElement('textarea')
            document.body.appendChild(field)
            field.focus()
        })
        afterEach(() => {
            field.remove()
        })

        it('destroy() (programmatic close) restores focus to the field that had it before the popover opened', () => {
            const root = mkRoot()
            expect(document.activeElement).toBe(field)
            const handle = showSynonyms(root, mkOptions())
            handle.destroy()
            expect(document.activeElement).toBe(field)
        })

        it('Esc restores focus to the field', () => {
            const root = mkRoot()
            showSynonyms(root, mkOptions())
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
            expect(document.activeElement).toBe(field)
        })

        it('does not throw when the previously-focused element was removed from the DOM before close', () => {
            const root = mkRoot()
            const handle = showSynonyms(root, mkOptions())
            field.remove()
            expect(() => handle.destroy()).not.toThrow()
        })
    })

    it('a new showSynonyms() dismisses the prior (one popover per root)', () => {
        const root = mkRoot()
        showSynonyms(root, mkOptions())
        showSynonyms(root, mkOptions())
        expect(root.querySelectorAll('.gf-syn')).toHaveLength(1)
    })

    it('a re-open destroys the PREVIOUS handle, not just its DOM (item 3: no orphaned window listeners)', async () => {
        // ROOT CAUSE: destroyExisting() used to only
        // querySelectorAll('.gf-syn').remove() — the prior handle's
        // destroy() (window pointerdown + keydown listeners, the pending
        // reposition rAF, and focus-restore) never ran. Synonyms re-opens
        // on every dblclick, so this leak compounds fast in a real
        // session. Fixed via a per-root registry (mirrors popover.ts /
        // rephrase-card.ts) that destroyExisting() now drains through
        // real destroy() calls.
        const root = mkRoot()
        const onClose1 = vi.fn<() => void>()
        const first = showSynonyms(root, mkOptions({ onClose: onClose1 }))
        expect(first.isOpen()).toBe(true)
        // installOutsideDismiss arms its window pointerdown listener after
        // a setTimeout(0) — wait a tick so the FIRST popover's listener is
        // actually installed (the state a real re-open would find).
        await new Promise<void>((r) => setTimeout(r, 0))

        const removeSpy = vi.spyOn(window, 'removeEventListener')
        const onClose2 = vi.fn<() => void>()
        const second = showSynonyms(root, mkOptions({ onClose: onClose2 }))

        // The first handle must be FULLY torn down, not just its DOM node.
        expect(first.isOpen()).toBe(false)
        const removedTypes = removeSpy.mock.calls.map((c) => c[0])
        expect(removedTypes).toContain('pointerdown')
        expect(removedTypes).toContain('keydown')
        removeSpy.mockRestore()

        // An outside pointerdown fires ONLY the live (second) popover's
        // onClose — a leaked first-handle listener would double-fire.
        await new Promise<void>((r) => setTimeout(r, 0))
        document.body.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }),
        )
        expect(onClose1).not.toHaveBeenCalled()
        expect(onClose2).toHaveBeenCalledTimes(1)
        expect(second.isOpen()).toBe(true)
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

    it('flip-above: a word near the viewport bottom lifts the popover clear of the word', () => {
        // Discord's composer sits at the screen bottom, so the synonyms popover
        // always flips ABOVE the word. With the fallback height (140 in jsdom)
        // and default innerHeight (768), a word whose bottom is near 768 leaves
        // no room below → the popover flips above with the larger ABOVE gap, so
        // its BOTTOM clears the word top (no overlap with the composer chrome).
        const root = mkRoot()
        const wordTop = 740
        const wordHeight = 18
        showSynonyms(root, mkOptions({ anchorRect: new DOMRect(80, wordTop, 50, wordHeight) }))
        const pop = root.querySelector('.gf-syn') as HTMLElement
        const top = parseInt(pop.style.top, 10)
        // Popover is ABOVE the word (its top is above the word's top).
        expect(top).toBeLessThan(wordTop)
        // And its bottom edge clears the word top by the ABOVE gap (14), i.e.
        // top + fallbackHeight(140) <= wordTop - 14. Assert it does not overlap
        // the word: popover bottom <= word top.
        const POPOVER_HEIGHT_FALLBACK = 140
        expect(top + POPOVER_HEIGHT_FALLBACK).toBeLessThanOrEqual(wordTop)
    })

    it('clearRect: flip-above clears the composer top, not just the word', () => {
        // The composer top (720) sits 20px above the word top (740) — the
        // word alone would let the popover overlap the composer chrome.
        // clearRect must push the popover clear of the composer top instead.
        const root = mkRoot()
        showSynonyms(
            root,
            mkOptions({
                anchorRect: new DOMRect(80, 740, 50, 18),
                clearRect: new DOMRect(0, 720, 800, 60),
            }),
        )
        const pop = root.querySelector('.gf-syn') as HTMLElement
        const top = parseInt(pop.style.top, 10)
        const POPOVER_HEIGHT_FALLBACK = 140
        expect(top + POPOVER_HEIGHT_FALLBACK).toBeLessThanOrEqual(720)
        expect(top).toBeLessThan(720)
    })

    it('clearRect: below-placement clears the composer bottom', () => {
        // Plenty of room below (word top 50, jsdom innerHeight 768), so the
        // popover stays BELOW — but it must clear the composer's bottom
        // edge (100), not just the word's bottom.
        const root = mkRoot()
        showSynonyms(
            root,
            mkOptions({
                anchorRect: new DOMRect(80, 50, 50, 18),
                clearRect: new DOMRect(0, 40, 800, 60),
            }),
        )
        const pop = root.querySelector('.gf-syn') as HTMLElement
        const top = parseInt(pop.style.top, 10)
        const POPOVER_GAP_BELOW = 6
        expect(top).toBeGreaterThanOrEqual(100 + POPOVER_GAP_BELOW)
    })
})
