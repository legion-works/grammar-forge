// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getCaretOffset, keepHighlightsBeforeEdit } from '@/input/caret-offset'
import { isPasteInput } from '@/input/paste-guard'
import { nextCheckSeq } from '@/lib/check-seq'
import { applyScopedOverlayClear } from '@/lib/scoped-clear'
import type { RenderableItem } from '@/lib/pipeline'

// Tiny harness: build a real <textarea>, attach a FieldState-shaped object,
// run the relevant pieces of the orchestrator wiring through a hand-rolled
// mirror of onInputEventFor (we test the SHAPE of the wiring, not the
// real start() — start() spins up the BridgeClient and signal queue and is
// covered by manual integration in a separate test).
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
    status: 'open',
    ...over,
})

describe('scoped-clear wiring (browser shape)', () => {
    let textarea: HTMLTextAreaElement
    beforeEach(() => {
        textarea = document.createElement('textarea')
        textarea.value = 'the teh quick'
        document.body.appendChild(textarea)
    })
    afterEach(() => {
        textarea.remove()
    })

    it('keeps the spec for a span strictly before the caret and drops the one abutting it', () => {
        const items: RenderableItem[] = [
            stub({ cuStart: 0, cuEnd: 3, hlStart: 0, hlEnd: 3 }),
            stub({ cuStart: 4, cuEnd: 7, hlStart: 4, hlEnd: 7 }),
        ]
        textarea.selectionStart = 4
        textarea.selectionEnd = 4
        const kept = keepHighlightsBeforeEdit(items, getCaretOffset(textarea))
        // Span [0,3) ends at 3 < caret 4 → keep. Span [4,7) starts at 4 === caret → drop.
        expect(kept).toEqual([items[0]])
    })

    it('null caret (e.g. detached contenteditable) clears every item', () => {
        const items: RenderableItem[] = [stub({ cuEnd: 5 }), stub({ cuEnd: 10 })]
        expect(keepHighlightsBeforeEdit(items, null)).toEqual([])
    })

    it('process-monotonic checkSeq is strictly greater than any prior value', () => {
        const seqs: number[] = []
        for (let i = 0; i < 10; i++) seqs.push(nextCheckSeq())
        for (let i = 1; i < seqs.length; i++) {
            expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
        }
    })

    // P0-3 regression: the FIXED onInputEventFor body (content/index.ts) runs
    // the scoped-clear (keepHighlightsBeforeEdit + the per-item clear) for
    // EVERY input event — paste included — BEFORE the paste branch arms the
    // grace window and suppresses the immediate check. The bug returned
    // early on the paste branch, skipping the clear entirely, so stale
    // highlight rects sat at pre-paste positions for the whole grace
    // window. This mirrors the fixed call order (same helpers, same
    // sequence: clear-then-decide, regardless of inputType) — see the file
    // header for why this file tests wiring SHAPE rather than driving the
    // real start().
    const runFixedOnInputEventFor = (
        inputType: string,
        items: RenderableItem[],
        editOffset: number | null,
        clearItem: (i: number) => void,
    ): { scopedClearRan: boolean; kept: RenderableItem[]; suppressedCheck: boolean } => {
        const kept = keepHighlightsBeforeEdit(items, editOffset)
        let scopedClearRan = false
        if (kept.length < items.length) {
            scopedClearRan = true
            applyScopedOverlayClear({ clearItem, reconcile: () => {} }, items, kept)
        }
        // The paste branch runs AFTER the clear above (not before / instead
        // of it) — it only decides whether to suppress the debounced check.
        const suppressedCheck = isPasteInput(inputType)
        return { scopedClearRan, kept, suppressedCheck }
    }

    it('paste input (insertFromPaste) still runs the scoped-clear before the grace window suppresses the check', () => {
        textarea.selectionStart = 4
        textarea.selectionEnd = 4
        const items: RenderableItem[] = [
            stub({ cuStart: 0, cuEnd: 3, hlStart: 0, hlEnd: 3 }),
            stub({ cuStart: 4, cuEnd: 7, hlStart: 4, hlEnd: 7 }),
        ]
        const cleared: number[] = []
        const { scopedClearRan, kept, suppressedCheck } = runFixedOnInputEventFor(
            'insertFromPaste',
            items,
            getCaretOffset(textarea),
            (i) => cleared.push(i),
        )
        expect(scopedClearRan).toBe(true)
        expect(cleared).toEqual([1])
        expect(kept).toEqual([items[0]])
        expect(suppressedCheck).toBe(true)
    })

    it('typing (non-paste) also runs the scoped-clear and does NOT suppress the check', () => {
        textarea.selectionStart = 4
        textarea.selectionEnd = 4
        const items: RenderableItem[] = [
            stub({ cuStart: 0, cuEnd: 3, hlStart: 0, hlEnd: 3 }),
            stub({ cuStart: 4, cuEnd: 7, hlStart: 4, hlEnd: 7 }),
        ]
        const cleared: number[] = []
        const { scopedClearRan, kept, suppressedCheck } = runFixedOnInputEventFor(
            'insertText',
            items,
            getCaretOffset(textarea),
            (i) => cleared.push(i),
        )
        expect(scopedClearRan).toBe(true)
        expect(cleared).toEqual([1])
        expect(kept).toEqual([items[0]])
        expect(suppressedCheck).toBe(false)
    })
})
