import { describe, expect, it, vi } from 'vitest'
import { getCaretOffset, keepHighlightsBeforeEdit } from '@/input/caret-offset'
import { nextCheckSeq } from '@/lib/check-seq'
import type { RenderableItem } from '@/lib/pipeline'
import * as rephraseCard from '@/overlay/rephrase-card'
import type { BridgeClient } from '@/api/client'
import { openRephraseFor, type RephraseDeps } from './rephrase'
import {
    inputGate,
    resolveSelectionSpan,
    hoverDecision,
    buildHoverPreviewText,
} from './orchestrator'
import { isWithinOverlay } from '@/overlay/shadow-host'

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

describe('onFieldBlur overlay-focus guard (vencord)', () => {
    // Tests the isWithinOverlay helper and the guard logic that onFieldBlur
    // uses. The orchestrator's onFieldBlur is a closure; we test the helper
    // directly and mirror the guard to verify RED→GREEN behaviour.
    it('preserves highlights when blur relatedTarget is inside the overlay host', () => {
        // Build a fake overlay host (mirrors what createOverlayHost produces)
        const overlayHost = document.createElement('div')
        overlayHost.setAttribute('data-grammarforge-overlay', '')
        const applyBtn = document.createElement('button')
        overlayHost.appendChild(applyBtn)
        document.body.appendChild(overlayHost)

        // relatedTarget = the Apply button inside the overlay (or the host
        // itself after shadow-boundary retargeting — both must be guarded)
        const blurEvent = new FocusEvent('blur', { relatedTarget: applyBtn })

        // Mirror of the guard: if isWithinOverlay(e.relatedTarget) → skip teardown
        const reconcileSpy = vi.fn<() => void>()
        const items = [{ id: 1 }, { id: 2 }]
        let itemsAfter = [...items]

        if (!isWithinOverlay(blurEvent.relatedTarget)) {
            itemsAfter = []
            reconcileSpy()
        }

        expect(reconcileSpy).not.toHaveBeenCalled()
        expect(itemsAfter).toHaveLength(2)

        overlayHost.remove()
    })

    it('clears highlights when blur relatedTarget is an unrelated element (genuine exit)', () => {
        const unrelated = document.createElement('input')
        document.body.appendChild(unrelated)

        const blurEvent = new FocusEvent('blur', { relatedTarget: unrelated })

        const reconcileSpy = vi.fn<() => void>()
        let itemsAfter = [{ id: 1 }, { id: 2 }]

        if (!isWithinOverlay(blurEvent.relatedTarget)) {
            itemsAfter = []
            reconcileSpy()
        }

        expect(reconcileSpy).toHaveBeenCalledOnce()
        expect(itemsAfter).toHaveLength(0)

        unrelated.remove()
    })

    it('clears highlights when blur relatedTarget is null (tab away / window blur)', () => {
        const blurEvent = new FocusEvent('blur', { relatedTarget: null })

        const reconcileSpy = vi.fn<() => void>()
        let itemsAfter = [{ id: 1 }, { id: 2 }]

        if (!isWithinOverlay(blurEvent.relatedTarget)) {
            itemsAfter = []
            reconcileSpy()
        }

        expect(reconcileSpy).toHaveBeenCalledOnce()
        expect(itemsAfter).toHaveLength(0)
    })

    it('isWithinOverlay returns true for the overlay host itself', () => {
        const host = document.createElement('div')
        host.setAttribute('data-grammarforge-overlay', '')
        document.body.appendChild(host)
        expect(isWithinOverlay(host)).toBe(true)
        host.remove()
    })

    it('isWithinOverlay returns false for null relatedTarget', () => {
        expect(isWithinOverlay(null)).toBe(false)
    })
})

describe('hoverDecision — pure hover-index change detection', () => {
    // hoverDecision(itemRects, x, y, prevIndex) → { index: number|null, changed: boolean }
    // Extracted pure function: given cursor position + item rects + previous hover index,
    // returns the new index (or null) and whether it changed.
    it('returns index 0 and changed=true when hovering item 0 from null', () => {
        const rects = [
            {
                item: stub({ diffOriginal: 'teh', diffCorrected: 'the' }),
                rects: [new DOMRect(10, 10, 40, 20)],
            },
        ]
        const result = hoverDecision(rects, 20, 15, null)
        expect(result).toEqual({ index: 0, changed: true })
    })

    it('returns null and changed=true when moving off all items', () => {
        const rects = [
            {
                item: stub({ diffOriginal: 'teh', diffCorrected: 'the' }),
                rects: [new DOMRect(10, 10, 40, 20)],
            },
        ]
        const result = hoverDecision(rects, 200, 200, 0)
        expect(result).toEqual({ index: null, changed: true })
    })

    it('returns same index and changed=false when still hovering the same item', () => {
        const rects = [
            {
                item: stub({ diffOriginal: 'teh', diffCorrected: 'the' }),
                rects: [new DOMRect(10, 10, 40, 20)],
            },
        ]
        const result = hoverDecision(rects, 25, 15, 0)
        expect(result).toEqual({ index: 0, changed: false })
    })

    it('returns index 1 and changed=true when moving from item 0 to item 1', () => {
        const rects = [
            {
                item: stub({ diffOriginal: 'teh', diffCorrected: 'the' }),
                rects: [new DOMRect(10, 10, 40, 20)],
            },
            {
                item: stub({ diffOriginal: 'aple', diffCorrected: 'apple' }),
                rects: [new DOMRect(60, 10, 50, 20)],
            },
        ]
        const result = hoverDecision(rects, 80, 15, 0)
        expect(result).toEqual({ index: 1, changed: true })
    })

    it('returns null and changed=false when still off all items', () => {
        const rects = [
            {
                item: stub({ diffOriginal: 'teh', diffCorrected: 'the' }),
                rects: [new DOMRect(10, 10, 40, 20)],
            },
        ]
        const result = hoverDecision(rects, 200, 200, null)
        expect(result).toEqual({ index: null, changed: false })
    })
})

describe('buildHoverPreviewText — preview text from a RenderableItem', () => {
    // buildHoverPreviewText(item) → string like "teh → the" or "aple → apple"
    it('returns "original → corrected" for a normal correction', () => {
        const item = stub({ diffOriginal: 'teh', diffCorrected: 'the', diffIsDeletion: false })
        expect(buildHoverPreviewText(item)).toBe('teh → the')
    })

    it('returns "original → (deleted)" for a deletion', () => {
        const item = stub({ diffOriginal: 'very', diffCorrected: '', diffIsDeletion: true })
        expect(buildHoverPreviewText(item)).toBe('very → (deleted)')
    })

    it('hovering item 0 then item 1 yields two distinct preview texts', () => {
        const item0 = stub({ diffOriginal: 'teh', diffCorrected: 'the', diffIsDeletion: false })
        const item1 = stub({ diffOriginal: 'aple', diffCorrected: 'apple', diffIsDeletion: false })
        const text0 = buildHoverPreviewText(item0)
        const text1 = buildHoverPreviewText(item1)
        expect(text0).not.toBe(text1)
        expect(text0).toBe('teh → the')
        expect(text1).toBe('aple → apple')
    })

    it('hovering off yields null (no preview text)', () => {
        // When hoverDecision returns index=null, the caller hides the tooltip.
        // buildHoverPreviewText is not called; this test documents the null→hide contract.
        const rects: Array<{ item: ReturnType<typeof stub>; rects: DOMRect[] }> = []
        const result = hoverDecision(rects, 0, 0, null)
        expect(result.index).toBeNull()
    })
})

describe('rephrase flow — pending → result is a single user-perceived transition', () => {
    it('shows pending, awaits rephrase, hides pending, shows result card', async () => {
        const pendingSpy = vi.spyOn(rephraseCard, 'showRephrasePending').mockReturnValue({
            hide: vi.fn<() => void>(),
        } as unknown as ReturnType<typeof rephraseCard.showRephrasePending>)
        const cardSpy = vi.spyOn(rephraseCard, 'showRephraseCard').mockReturnValue({
            hide: vi.fn<() => void>(),
        } as unknown as ReturnType<typeof rephraseCard.showRephraseCard>)

        const client = {
            rephrase: vi.fn<(req: unknown) => Promise<unknown>>(async () => ({
                original: 'hello world',
                rephrased: 'hi there',
                alternatives: [],
            })),
        } as unknown as BridgeClient
        const deps: RephraseDeps = {
            client: () => client,
            overlayRoot: document.createElement('div') as unknown as ShadowRoot,
            debugLog: vi.fn<(...args: unknown[]) => void>(),
        }
        const el = document.createElement('div')
        document.body.appendChild(el)

        await openRephraseFor(el, 'hello world', { start: 0, end: 11 }, deps, () => {})

        // pending was shown exactly once
        expect(pendingSpy.mock.calls.length).toBe(1)
        // result card was shown exactly once
        expect(cardSpy.mock.calls.length).toBe(1)
        // Call ordering: pending before card
        const pendingOrder = pendingSpy.mock.invocationCallOrder[0] ?? 0
        const cardOrder = cardSpy.mock.invocationCallOrder[0] ?? 0
        expect(pendingOrder).toBeLessThan(cardOrder)

        // Anchor rect on the result card is derived from the same el — the
        // user-perceived "in place" transition. The current code calls
        // getBoundingClientRect twice (once for pending, once for card),
        // so we assert EQUAL rects (same left/top/width/height) rather than
        // identity. (Refactor opportunity: hoist the rect read.)
        const pendingAnchor = pendingSpy.mock.calls[0]?.[1]?.anchorRect as DOMRect | undefined
        const cardAnchor = cardSpy.mock.calls[0]?.[1]?.anchorRect as DOMRect | undefined
        expect(pendingAnchor).toBeDefined()
        expect(cardAnchor).toBeDefined()
        expect(cardAnchor!.left).toBe(pendingAnchor!.left)
        expect(cardAnchor!.top).toBe(pendingAnchor!.top)
        expect(cardAnchor!.width).toBe(pendingAnchor!.width)
        expect(cardAnchor!.height).toBe(pendingAnchor!.height)
    })
})
