// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { getCaretOffset, keepHighlightsBeforeEdit } from './caret-offset'
import type { RenderableItem } from '@/lib/pipeline'

function mkTextarea(value: string, start: number, end = start): HTMLTextAreaElement {
    const t = document.createElement('textarea')
    t.value = value
    t.selectionStart = start
    t.selectionEnd = end
    document.body.appendChild(t)
    return t
}

function mkInput(value: string, start: number): HTMLInputElement {
    const i = document.createElement('input')
    i.value = value
    i.selectionStart = start
    i.selectionEnd = start
    document.body.appendChild(i)
    return i
}

function mkContentEditable(html: string): HTMLElement {
    const d = document.createElement('div')
    d.setAttribute('contenteditable', 'true')
    d.innerHTML = html
    document.body.appendChild(d)
    return d
}

function placeCaretAtTextOffset(el: HTMLElement, cuOffset: number): void {
    const sel = el.ownerDocument.getSelection()
    if (!sel) throw new Error('no selection in test')
    const range = document.createRange()
    // Find the text node that contains cuOffset (single-text-node fields only).
    const tn = el.firstChild as Text
    range.setStart(tn, cuOffset)
    range.setEnd(tn, cuOffset)
    sel.removeAllRanges()
    sel.addRange(range)
}

const stub = (over: Partial<RenderableItem>): RenderableItem => ({
    cuStart: 0,
    cuEnd: 0,
    hlStart: 0,
    hlEnd: 0,
    category: 'spelling',
    message: '',
    replacements: ['x'],
    original: '',
    diffOriginal: '',
    diffCorrected: '',
    diffIsDeletion: false,
    byteSpan: { start: 0, end: 0 },
    model: 'harper',
    ...over,
})

describe('getCaretOffset', () => {
    it('returns textarea selectionStart verbatim', () => {
        const t = mkTextarea('hello world', 6)
        expect(getCaretOffset(t)).toBe(6)
    })
    it('returns input selectionStart verbatim', () => {
        const i = mkInput('hello world', 6)
        expect(getCaretOffset(i)).toBe(6)
    })
    it('returns the flat code-unit offset of a contenteditable caret', () => {
        const el = mkContentEditable('the cat sat')
        placeCaretAtTextOffset(el, 4) // between "the " and "cat"
        expect(getCaretOffset(el)).toBe(4)
    })
    it('returns 0 for a contenteditable caret at the start', () => {
        const el = mkContentEditable('the cat sat')
        placeCaretAtTextOffset(el, 0)
        expect(getCaretOffset(el)).toBe(0)
    })
    it('returns the text length for a contenteditable caret at the end', () => {
        const el = mkContentEditable('the cat sat')
        placeCaretAtTextOffset(el, 11)
        expect(getCaretOffset(el)).toBe(11)
    })
    it('returns null when the contenteditable has no selection', () => {
        const el = mkContentEditable('the cat sat')
        const sel = el.ownerDocument.getSelection()
        sel?.removeAllRanges()
        expect(getCaretOffset(el)).toBeNull()
    })
    it('returns null when the contenteditable selection is outside the field', () => {
        const el = mkContentEditable('the cat sat')
        const elsewhere = document.createElement('div')
        elsewhere.textContent = 'other'
        document.body.appendChild(elsewhere)
        const sel = el.ownerDocument.getSelection()
        const range = document.createRange()
        range.setStart(elsewhere.firstChild!, 0)
        range.setEnd(elsewhere.firstChild!, 0)
        sel?.removeAllRanges()
        sel?.addRange(range)
        expect(getCaretOffset(el)).toBeNull()
    })
})

describe('keepHighlightsBeforeEdit', () => {
    it('keeps every spec when the edit offset is past every end', () => {
        const specs = [stub({ cuEnd: 5 }), stub({ cuEnd: 10 })]
        expect(keepHighlightsBeforeEdit(specs, 20)).toEqual(specs)
    })
    it('drops every spec when the edit offset is before every start', () => {
        const specs = [stub({ cuStart: 5, cuEnd: 10 }), stub({ cuStart: 15, cuEnd: 20 })]
        expect(keepHighlightsBeforeEdit(specs, 0)).toEqual([])
    })
    it('keeps every spec whose end is at or before the edit offset', () => {
        // Plan deviation: the original plan text wrote this case with the
        // assertion `[before]` only, which is inconsistent with the doc-comment
        // rule `cuEnd <= editOffset` (the atBoundary and endsBefore cases
        // would also survive) and with the sibling "exact boundary" test.
        // We follow the spec text (`end <= editOffset`) and the exact-boundary
        // test, which the doc-comment also codifies ("edit is AFTER them").
        const before = stub({ cuStart: 0, cuEnd: 5 })
        const endsBefore = stub({ cuStart: 4, cuEnd: 9 })
        const atBoundary = stub({ cuStart: 0, cuEnd: 10 })
        const after = stub({ cuStart: 12, cuEnd: 20 })
        const out = keepHighlightsBeforeEdit([before, endsBefore, atBoundary, after], 10)
        expect(out).toEqual([before, endsBefore, atBoundary])
    })
    it('treats an exact boundary as keepable (end === editOffset survives)', () => {
        // Span [0, 10) survives when the edit is AT 10: the inserted character
        // lands AFTER the span, so the rects are unaffected.
        const exact = stub({ cuStart: 0, cuEnd: 10 })
        expect(keepHighlightsBeforeEdit([exact], 10)).toEqual([exact])
    })
    it('drops specs that start after the edit (caret moved past them)', () => {
        const a = stub({ cuStart: 0, cuEnd: 3 })
        const b = stub({ cuStart: 20, cuEnd: 25 })
        expect(keepHighlightsBeforeEdit([a, b], 5)).toEqual([a])
    })
    it('returns an empty list for an empty input', () => {
        expect(keepHighlightsBeforeEdit([], 10)).toEqual([])
    })
    it('returns an empty list for a null edit offset (caller should clear-all)', () => {
        // null is the contract for "indeterminate caret" — keep helper still
        // returns [] so the caller can do `reconcile(keep(...))` unconditionally.
        const specs = [stub({ cuEnd: 5 })]
        expect(keepHighlightsBeforeEdit(specs, null)).toEqual([])
    })
})
