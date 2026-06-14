import { describe, expect, it } from 'vitest'
import { getCaretOffset, keepHighlightsBeforeEdit } from '@/input/caret-offset'
import { nextCheckSeq } from '@/lib/check-seq'
import type { RenderableItem } from '@/lib/pipeline'
import { inputGate, resolveSelectionSpan } from './orchestrator'

describe('inputGate', () => {
    it('schedules a check for plain typing', () => {
        expect(inputGate('insertText', { checkPastedText: false })).toBe('check')
    })
    it('skips pastes when checkPastedText is off', () => {
        expect(inputGate('insertFromPaste', { checkPastedText: false })).toBe('skip')
    })
    it('defers pastes to the grace window when checkPastedText is on', () => {
        expect(inputGate('insertFromPaste', { checkPastedText: true })).toBe('grace')
    })
    it('treats unknown/empty inputType as typing', () => {
        expect(inputGate('', { checkPastedText: false })).toBe('check')
    })
})

describe('resolveSelectionSpan', () => {
    it('returns the endpoints verbatim when both resolve and are ordered', () => {
        expect(resolveSelectionSpan(5, 10)).toEqual({ start: 5, end: 10 })
    })
    it('returns {0,0} when the start endpoint is unresolvable', () => {
        expect(resolveSelectionSpan(null, 10)).toEqual({ start: 0, end: 0 })
    })
    it('returns {0,0} when the end endpoint is unresolvable', () => {
        expect(resolveSelectionSpan(5, null)).toEqual({ start: 0, end: 0 })
    })
    it('returns {0,0} when both endpoints are unresolvable', () => {
        expect(resolveSelectionSpan(null, null)).toEqual({ start: 0, end: 0 })
    })
    it('returns {0,0} when the endpoints are inverted (end < start)', () => {
        expect(resolveSelectionSpan(10, 5)).toEqual({ start: 0, end: 0 })
    })
    it('keeps a collapsed selection (end === start) as-is for the caller to discard', () => {
        expect(resolveSelectionSpan(5, 5)).toEqual({ start: 5, end: 5 })
    })
})

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

describe('scoped-clear wiring (vencord shape)', () => {
    it('keeps a span strictly before the caret and drops one starting at the caret', () => {
        const div = document.createElement('div')
        div.setAttribute('contenteditable', 'true')
        div.textContent = 'the teh quick'
        document.body.appendChild(div)
        // Place caret at code-unit 4 (between "the " and "teh").
        const sel = document.getSelection()!
        const range = document.createRange()
        range.setStart(div.firstChild!, 4)
        range.setEnd(div.firstChild!, 4)
        sel.removeAllRanges()
        sel.addRange(range)
        const items: RenderableItem[] = [
            stub({ cuStart: 0, cuEnd: 3, hlStart: 0, hlEnd: 3 }),
            stub({ cuStart: 4, cuEnd: 7, hlStart: 4, hlEnd: 7 }),
        ]
        const kept = keepHighlightsBeforeEdit(items, getCaretOffset(div))
        expect(kept).toEqual([items[0]])
    })

    it('null caret clears every item (indeterminate Slate state)', () => {
        const div = document.createElement('div')
        div.setAttribute('contenteditable', 'true')
        div.textContent = 'the teh quick'
        document.body.appendChild(div)
        const sel = document.getSelection()!
        sel.removeAllRanges()
        const items: RenderableItem[] = [stub({ cuEnd: 5 }), stub({ cuEnd: 10 })]
        expect(keepHighlightsBeforeEdit(items, getCaretOffset(div))).toEqual([])
    })

    it('process-monotonic checkSeq is strictly greater than any prior value', () => {
        const seqs: number[] = []
        for (let i = 0; i < 10; i++) seqs.push(nextCheckSeq())
        for (let i = 1; i < seqs.length; i++) {
            expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
        }
    })
})
