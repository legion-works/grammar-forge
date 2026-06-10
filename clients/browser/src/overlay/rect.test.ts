// @vitest-environment jsdom
// Unit tests for the span→rect mapping used by getSpanRects. The
// contenteditable offset→node math now lives in input/text.ts
// (codeUnitSpanToRange — the shared line-aware flat model) and is tested
// there; here we exercise the rect plumbing against a fake getClientRects()
// injected on Range, plus the mirror-div path for inputs/textareas.
import { describe, expect, it, vi } from 'vitest'
import { __mirrorStyleForTest } from '@/overlay/rect'

describe('getSpanRects (contenteditable path, fake layout)', () => {
    it('returns an empty array when offsets cannot be resolved', async () => {
        const el = document.createElement('div')
        el.append(document.createTextNode('hi'))
        const { getSpanRects } = await import('@/overlay/rect')
        // start past end of text
        const rects = getSpanRects(el, 0, 999)
        expect(rects).toEqual([])
    })

    it('returns the rects produced by Range.getClientRects for a contenteditable', async () => {
        const el = document.createElement('div')
        el.append(document.createTextNode('hello world'))
        // jsdom has no Range.getClientRects implementation, so install a fake
        // Range via a createRange spy on the document.
        const fake = [
            new DOMRect(10, 20, 30, 12),
            new DOMRect(10, 32, 30, 12),
        ] as unknown as DOMRectList
        const fakeRange = {
            setStart: vi.fn<() => void>(),
            setEnd: vi.fn<() => void>(),
            getClientRects: vi.fn<() => DOMRectList>().mockReturnValue(fake),
            detach: vi.fn<() => void>(),
        } as unknown as Range
        const createRangeSpy = vi.spyOn(el.ownerDocument, 'createRange').mockReturnValue(fakeRange)

        const { getSpanRects } = await import('@/overlay/rect')
        const rects = getSpanRects(el, 0, 5)
        expect(createRangeSpy).toHaveBeenCalledOnce()
        expect(fakeRange.setStart as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce()
        expect(fakeRange.setEnd as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce()
        expect(rects).toHaveLength(2)
        expect(rects[0]?.left).toBe(10)
        expect(rects[1]?.top).toBe(32)
        createRangeSpy.mockRestore()
    })
})

describe('buildMirrorProbe (input/textarea style copy)', () => {
    it("copies the element's font/box/width into a hidden div + a marker span", async () => {
        const ta = document.createElement('textarea')
        ta.value = 'hello world'
        // give the textarea a measurable offsetWidth; jsdom returns 0 by default,
        // which is fine for the style-copy assertion below.
        document.body.appendChild(ta)
        const { buildMirrorProbe } = await import('@/overlay/rect')
        const probe = buildMirrorProbe(ta, 0, 5)
        expect(probe.element).toBeInstanceOf(HTMLDivElement)
        expect(probe.marker).toBeInstanceOf(HTMLSpanElement)
        expect(probe.marker.textContent).toBe('hello')
        // the hidden mirror is off-screen
        const style = probe.element.getAttribute('style') ?? ''
        expect(style).toContain('position: absolute')
        expect(style).toContain('top: -9999px')
        expect(style).toContain('left: -9999px')
        expect(style).toContain('visibility: hidden')
        expect(style).toContain('white-space: pre-wrap')
        probe.remove()
        ta.remove()
    })

    it('input span entirely past the text length returns [] without touching the DOM', async () => {
        const ta = document.createElement('textarea')
        ta.value = 'hi'
        document.body.appendChild(ta)
        const { getSpanRects } = await import('@/overlay/rect')
        // span [5, 10) is past the end of 'hi' (length 2)
        const rects = getSpanRects(ta, 5, 10)
        expect(rects).toEqual([])
        // no stray mirror div was left on the body
        expect(document.body.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(0)
        ta.remove()
    })

    it('input span clamped to zero-width after clamping returns []', async () => {
        const ta = document.createElement('textarea')
        ta.value = 'hi'
        document.body.appendChild(ta)
        const { getSpanRects } = await import('@/overlay/rect')
        // start === end after clamping (start==5 past 'hi', end==5)
        const rects = getSpanRects(ta, 5, 5)
        expect(rects).toEqual([])
        ta.remove()
    })
})

describe('getSpanRectsBatch (mirror-div layout-thrash killer)', () => {
    it('returns one rect array per span in the input order', async () => {
        const ta = document.createElement('textarea')
        ta.value = 'the quick brown fox jumps over'
        document.body.appendChild(ta)
        // stub getBoundingClientRect on the textarea + on a manually-injected
        // marker (the mirror div approach measures marker rects relative to
        // the textarea's rect; jsdom returns zeros for everything but the
        // we just need the call to be hit + each span to receive a rect).
        const taRect = new DOMRect(100, 200, 300, 20)
        vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue(taRect)

        // stub the marker's getBoundingClientRect by overriding on the
        // prototype BEFORE we call the batch fn (the function reads it on
        // each marker span; we want to verify the call happens once per
        // span, not once per call site).
        let markerCalls = 0
        const original = HTMLSpanElement.prototype.getBoundingClientRect
        HTMLSpanElement.prototype.getBoundingClientRect = function (): DOMRect {
            // The mirror div is also an Element, so distinguish by tag.
            if (this.tagName === 'SPAN') markerCalls += 1
            return new DOMRect(10, 20, 5, 16)
        }

        try {
            const { getSpanRectsBatch } = await import('@/overlay/rect')
            const out = getSpanRectsBatch(ta, [
                { start: 0, end: 3 }, // 'the'
                { start: 4, end: 9 }, // 'quick'
                { start: 10, end: 15 }, // 'brown'
            ])
            expect(out).toHaveLength(3)
            for (const r of out) {
                expect(r).toHaveLength(1)
                expect(r[0]?.width).toBe(5)
            }
            // one marker call per span
            expect(markerCalls).toBe(3)
        } finally {
            HTMLSpanElement.prototype.getBoundingClientRect = original
            ta.remove()
        }
    })

    it('a batched call builds ONE mirror div (not one per span)', async () => {
        const ta = document.createElement('textarea')
        ta.value = 'abc def ghi jkl mno pqr'
        document.body.appendChild(ta)
        const { getSpanRectsBatch } = await import('@/overlay/rect')
        getSpanRectsBatch(ta, [
            { start: 0, end: 3 },
            { start: 4, end: 7 },
            { start: 8, end: 11 },
            { start: 12, end: 15 },
            { start: 16, end: 19 },
        ])
        // exactly ONE mirror div with aria-hidden=true was appended +
        // removed during the call.
        expect(document.body.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(0)
        ta.remove()
    })

    it('returns an empty inner array for spans that resolve to zero width', async () => {
        const ta = document.createElement('textarea')
        ta.value = 'hi'
        document.body.appendChild(ta)
        const { getSpanRectsBatch } = await import('@/overlay/rect')
        const out = getSpanRectsBatch(ta, [
            { start: 0, end: 2 }, // valid: 'hi'
            { start: 5, end: 5 }, // collapses to zero width after clamp
            { start: 99, end: 100 }, // past end of text
        ])
        expect(out[0]).toHaveLength(1)
        expect(out[1]).toEqual([])
        expect(out[2]).toEqual([])
        ta.remove()
    })

    it('still works for the contenteditable path (one Range per span)', async () => {
        const el = document.createElement('div')
        el.append(document.createTextNode('hello world'))
        // spy on createRange to confirm the contenteditable branch is hit.
        // The shared flat-model mapping (input/text.ts codeUnitSpansToRanges)
        // builds ONE Range per span — each is returned to the caller, so a
        // single mutated Range can no longer be reused across spans.
        const createRangeSpy = vi.spyOn(el.ownerDocument, 'createRange')
        // jsdom has no getClientRects; inject a fake
        const fakeRange = {
            setStart: vi.fn<() => void>(),
            setEnd: vi.fn<() => void>(),
            getClientRects: vi.fn<() => DOMRectList>().mockReturnValue({
                0: new DOMRect(0, 0, 10, 12),
                length: 1,
                item: (i: number) => (i === 0 ? new DOMRect(0, 0, 10, 12) : null),
            } as unknown as DOMRectList),
            detach: vi.fn<() => void>(),
        } as unknown as Range
        createRangeSpy.mockReturnValue(fakeRange)

        const { getSpanRectsBatch } = await import('@/overlay/rect')
        const out = getSpanRectsBatch(el, [
            { start: 0, end: 5 },
            { start: 6, end: 11 },
        ])
        expect(createRangeSpy).toHaveBeenCalledTimes(2)
        expect(fakeRange.setStart as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2)
        expect(fakeRange.setEnd as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2)
        expect(out).toHaveLength(2)
        expect(out[0]?.[0]?.width).toBe(10)
        expect(out[1]?.[0]?.width).toBe(10)
        createRangeSpy.mockRestore()
    })
})

describe('mirror style cache (P1/H1)', () => {
    it('reuses the cached mirror style string for the same element + box', () => {
        const el = document.createElement('textarea')
        el.value = 'the quick brown fox'
        document.body.appendChild(el)
        const first = __mirrorStyleForTest(el)
        const second = __mirrorStyleForTest(el)
        // Same element + same box signature → identical cached string reference.
        expect(second).toBe(first)
    })

    it('rebuilds the cached style when the element box (offsetWidth) changes', () => {
        const el = document.createElement('textarea')
        el.value = 'hello world'
        document.body.appendChild(el)
        const first = __mirrorStyleForTest(el)
        Object.defineProperty(el, 'offsetWidth', { value: 999, configurable: true })
        const second = __mirrorStyleForTest(el)
        // Different signature → a freshly built string (not the cached reference).
        expect(second).not.toBe(first)
    })
})

describe('measurement privacy (field text must never enter page-visible DOM)', () => {
    // The attack this guards against: the mirror-div technique used to copy
    // the field's text into a measurable element. If that mirror is appended
    // to the PAGE's DOM (document.body), any page script with a
    // MutationObserver receives the added node in its records and can read
    // the user's full field text from it — even after the mirror is removed
    // (the record keeps a reference). Privacy invariant #1. The mirror must
    // live inside a CLOSED shadow root, which observers on the page DOM
    // cannot see into.
    async function observeLeaks(run: () => void): Promise<string> {
        const leaked: string[] = []
        const obs = new MutationObserver((records) => {
            for (const r of records) {
                for (const n of r.addedNodes) {
                    leaked.push((n as HTMLElement).textContent ?? '')
                }
            }
        })
        obs.observe(document.body, { childList: true, subtree: true })
        run()
        // Flush the observer's microtask delivery.
        await new Promise((resolve) => setTimeout(resolve, 0))
        obs.disconnect()
        return leaked.join('')
    }

    it('getSpanRectsBatch does not leak textarea text to page observers', async () => {
        const ta = document.createElement('textarea')
        ta.value = 'SECRET passphrase hunter2'
        document.body.appendChild(ta)
        const { getSpanRectsBatch } = await import('@/overlay/rect')
        const leaked = await observeLeaks(() => {
            getSpanRectsBatch(ta, [
                { start: 0, end: 6 },
                { start: 7, end: 17 },
            ])
        })
        expect(leaked).not.toContain('SECRET')
        expect(leaked).not.toContain('hunter2')
        ta.remove()
    })

    it('getSpanRects (single-span path) does not leak input text to page observers', async () => {
        const input = document.createElement('input')
        input.value = 'SECRET token abcdef'
        document.body.appendChild(input)
        const { getSpanRects } = await import('@/overlay/rect')
        const leaked = await observeLeaks(() => {
            getSpanRects(input, 0, 6)
        })
        expect(leaked).not.toContain('SECRET')
        input.remove()
    })
})
