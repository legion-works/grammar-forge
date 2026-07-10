// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { resolveRephraseScope, openRephraseFor, type RephraseDeps } from './rephrase'
import * as rephraseCard from '@/overlay/rephrase-card'
import type { BridgeClient } from '@/api/client'

describe('resolveRephraseScope', () => {
    it('returns the selection when it matches the target element', () => {
        const el = document.createElement('div')
        document.body.appendChild(el)
        const found = { el, text: 'sel', span: { start: 0, end: 3 } }
        const got = resolveRephraseScope(el, found)
        expect(got).toEqual({ el, text: 'sel', span: { start: 0, end: 3 } })
    })
    it('returns null when no selection and the field is empty', () => {
        const el = document.createElement('div')
        el.innerHTML = ''
        document.body.appendChild(el)
        expect(resolveRephraseScope(el, null)).toBeNull()
    })
    it('returns null when no selection and the field is whitespace-only', () => {
        const el = document.createElement('div')
        el.innerHTML = '   \n  '
        document.body.appendChild(el)
        expect(resolveRephraseScope(el, null)).toBeNull()
    })
    it('falls back to the whole field when the selection is in a different element', () => {
        const target = document.createElement('div')
        target.innerHTML = 'whole text'
        const other = document.createElement('div')
        document.body.appendChild(target)
        document.body.appendChild(other)
        const found = { el: other, text: 'x', span: { start: 0, end: 1 } }
        expect(resolveRephraseScope(target, found)).toEqual({
            el: target,
            text: 'whole text',
            span: { start: 0, end: 10 },
        })
    })
    it('whole-field scope span covers every character (start=0, end=text.length)', () => {
        const target = document.createElement('div')
        target.innerHTML = 'abcdef'
        document.body.appendChild(target)
        expect(resolveRephraseScope(target, null)).toEqual({
            el: target,
            text: 'abcdef',
            span: { start: 0, end: 6 },
        })
    })
})

// W3-3: the rephrase card's initial tone is seeded from the user's
// goals (formal→'formal', informal→'casual', neutral→'neutral'). The
// shared `defaultToneFromGoals` does the math; the orchestrator passes
// a getter via `RephraseDeps.defaultTone`. We assert the card receives
// the seeded tone by spying on `showRephraseCard`.
describe('openRephraseFor — goals-seeded tone', () => {
    it('uses the supplied defaultTone getter for the rephrase card', async () => {
        vi.spyOn(rephraseCard, 'showRephrasePending').mockReturnValue({
            hide: vi.fn<() => void>(),
        } as unknown as ReturnType<typeof rephraseCard.showRephrasePending>)
        const cardSpy = vi
            .spyOn(rephraseCard, 'showRephraseCard')
            .mockReturnValue({ hide: vi.fn<() => void>() } as unknown as ReturnType<
                typeof rephraseCard.showRephraseCard
            >)

        const client = {
            rephrase: vi.fn<(req: unknown) => Promise<unknown>>(async () => ({
                original: 'hello',
                rephrased: 'hi',
                alternatives: [],
            })),
        } as unknown as BridgeClient
        const defaultTone = vi.fn<() => 'neutral' | 'formal' | 'casual'>(() => 'casual')
        const deps: RephraseDeps = {
            client: () => client,
            overlayRoot: document.createElement('div') as unknown as ShadowRoot,
            debugLog: vi.fn<(...args: unknown[]) => void>(),
            defaultTone,
        }
        const el = document.createElement('div')
        el.innerHTML = 'hello'
        document.body.appendChild(el)

        await openRephraseFor(el, 'hello', { start: 0, end: 5 }, deps, () => {})

        expect(defaultTone).toHaveBeenCalled()
        expect(cardSpy.mock.calls[0]?.[1]?.tone).toBe('casual')
    })

    it('falls back to "neutral" when no defaultTone getter is supplied (back-compat)', async () => {
        vi.spyOn(rephraseCard, 'showRephrasePending').mockReturnValue({
            hide: vi.fn<() => void>(),
        } as unknown as ReturnType<typeof rephraseCard.showRephrasePending>)
        const cardSpy = vi
            .spyOn(rephraseCard, 'showRephraseCard')
            .mockReturnValue({ hide: vi.fn<() => void>() } as unknown as ReturnType<
                typeof rephraseCard.showRephraseCard
            >)
        // Clear the call log so this test inspects ITS OWN call only — the
        // prior test's `showRephraseCard` mock invocation is still on the
        // shared spy and would otherwise show as the first call.
        cardSpy.mockClear()

        const client = {
            rephrase: vi.fn<(req: unknown) => Promise<unknown>>(async () => ({
                original: 'hello',
                rephrased: 'hi',
                alternatives: [],
            })),
        } as unknown as BridgeClient
        const deps: RephraseDeps = {
            client: () => client,
            overlayRoot: document.createElement('div') as unknown as ShadowRoot,
            debugLog: vi.fn<(...args: unknown[]) => void>(),
        }
        const el = document.createElement('div')
        el.innerHTML = 'hello'
        document.body.appendChild(el)

        await openRephraseFor(el, 'hello', { start: 0, end: 5 }, deps, () => {})

        expect(cardSpy.mock.calls[0]?.[1]?.tone).toBe('neutral')
    })
})

// Regression: onScopeChange/onToneChange/onRegenerate used to only
// debugLog — Formal/Casual/Regenerate taps on the Vencord rephrase card
// were dead buttons and `tone` never reached the bridge request at all.
// They must now re-issue the bridge call (mirrors the browser client's
// re-issue semantics) and the current tone must always be forwarded.
describe('openRephraseFor — scope/tone/regenerate re-issue the bridge call', () => {
    function setup() {
        vi.spyOn(rephraseCard, 'showRephrasePending').mockReturnValue({
            hide: vi.fn<() => void>(),
        } as unknown as ReturnType<typeof rephraseCard.showRephrasePending>)
        const cardSpy = vi
            .spyOn(rephraseCard, 'showRephraseCard')
            .mockReturnValue({ hide: vi.fn<() => void>() } as unknown as ReturnType<
                typeof rephraseCard.showRephraseCard
            >)
        cardSpy.mockClear()
        const rephrase = vi.fn(async (req: { tone?: string }) => ({
            original: 'hello',
            rephrased: `hi (${req.tone ?? 'none'})`,
            alternatives: [],
        }))
        const client = { rephrase } as unknown as BridgeClient
        const deps: RephraseDeps = {
            client: () => client,
            overlayRoot: document.createElement('div') as unknown as ShadowRoot,
            debugLog: vi.fn<(...args: unknown[]) => void>(),
            defaultTone: () => 'neutral',
        }
        const el = document.createElement('div')
        el.innerHTML = 'hello'
        document.body.appendChild(el)
        return { cardSpy, rephrase, deps, el }
    }

    it('forwards tone to the bridge request on the initial call', async () => {
        const { rephrase, deps, el } = setup()
        await openRephraseFor(el, 'hello', { start: 0, end: 5 }, deps, () => {})
        expect(rephrase).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'hello', tone: 'neutral' }),
        )
    })

    it('onRegenerate re-issues the same scope/tone', async () => {
        const { cardSpy, rephrase, deps, el } = setup()
        await openRephraseFor(el, 'hello', { start: 0, end: 5 }, deps, () => {})
        const opts = cardSpy.mock.calls[0]?.[1] as { onRegenerate: () => void }
        opts.onRegenerate()
        await Promise.resolve()
        await Promise.resolve()
        expect(rephrase).toHaveBeenCalledTimes(2)
        expect(rephrase.mock.calls[1]?.[0]).toEqual(
            expect.objectContaining({ tone: 'neutral' }),
        )
    })

    it('onToneChange re-issues with the new tone and updates the card', async () => {
        const { cardSpy, rephrase, deps, el } = setup()
        await openRephraseFor(el, 'hello', { start: 0, end: 5 }, deps, () => {})
        const opts = cardSpy.mock.calls[0]?.[1] as { onToneChange: (t: string) => void }
        opts.onToneChange('formal')
        await Promise.resolve()
        await Promise.resolve()
        expect(rephrase).toHaveBeenCalledTimes(2)
        expect(rephrase.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ tone: 'formal' }))
        expect(cardSpy.mock.calls[1]?.[1]?.tone).toBe('formal')
    })

    it('onScopeChange re-issues and updates the card scope', async () => {
        const { cardSpy, rephrase, deps, el } = setup()
        await openRephraseFor(el, 'hello', { start: 0, end: 5 }, deps, () => {})
        const opts = cardSpy.mock.calls[0]?.[1] as { onScopeChange: (s: string) => void }
        opts.onScopeChange('message')
        await Promise.resolve()
        await Promise.resolve()
        expect(rephrase).toHaveBeenCalledTimes(2)
        expect(cardSpy.mock.calls[1]?.[1]?.scope).toBe('message')
    })
})

// Placement audit: the pending/result/error card must anchor to the
// SELECTION rect (when supplied) instead of always falling back to the
// composer's whole bounding box — mirrors the browser client's fix in
// clients/browser/src/entrypoints/content/rephrase.ts. Without this, the
// split control's Rephrase segment opened a card anchored to the
// selection (via the control) that then visibly jumped to the composer's
// bounding box the instant the pending/result card mounted.
describe('openRephraseFor — anchors to the supplied rect, not the composer (placement audit)', () => {
    function setup() {
        const pendingSpy = vi.spyOn(rephraseCard, 'showRephrasePending').mockReturnValue({
            hide: vi.fn<() => void>(),
        } as unknown as ReturnType<typeof rephraseCard.showRephrasePending>)
        const cardSpy = vi
            .spyOn(rephraseCard, 'showRephraseCard')
            .mockReturnValue({ hide: vi.fn<() => void>() } as unknown as ReturnType<
                typeof rephraseCard.showRephraseCard
            >)
        pendingSpy.mockClear()
        cardSpy.mockClear()
        const rephrase = vi.fn<(req: unknown) => Promise<unknown>>(async () => ({
            original: 'hello',
            rephrased: 'hi',
            alternatives: [],
        }))
        const client = { rephrase } as unknown as BridgeClient
        const deps: RephraseDeps = {
            client: () => client,
            overlayRoot: document.createElement('div') as unknown as ShadowRoot,
            debugLog: vi.fn<(...args: unknown[]) => void>(),
            defaultTone: () => 'neutral',
        }
        const el = document.createElement('div')
        el.innerHTML = 'hello'
        document.body.appendChild(el)
        // Distinct from the selection rect below — if the card falls back
        // to this, the test catches the regression.
        vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 900))
        return { pendingSpy, cardSpy, deps, el }
    }

    it('uses the supplied anchorRect for the pending AND result card, not el.getBoundingClientRect()', async () => {
        const { pendingSpy, cardSpy, deps, el } = setup()
        const selectionRect = new DOMRect(42, 84, 50, 16)
        await openRephraseFor(
            el,
            'hello',
            { start: 0, end: 5 },
            deps,
            () => {},
            null,
            selectionRect,
        )
        expect(pendingSpy.mock.calls[0]?.[1]?.anchorRect).toBe(selectionRect)
        expect(cardSpy.mock.calls[0]?.[1]?.anchorRect).toBe(selectionRect)
    })

    it('falls back to el.getBoundingClientRect() when no anchorRect is supplied (whole-field rephrase)', async () => {
        const { pendingSpy, deps, el } = setup()
        await openRephraseFor(el, 'hello', { start: 0, end: 5 }, deps, () => {})
        expect(pendingSpy.mock.calls[0]?.[1]?.anchorRect).toEqual(new DOMRect(0, 0, 900, 900))
    })

    it('reuses the SAME anchor across the onRegenerate re-issue', async () => {
        const { cardSpy, deps, el } = setup()
        const selectionRect = new DOMRect(10, 20, 30, 12)
        await openRephraseFor(
            el,
            'hello',
            { start: 0, end: 5 },
            deps,
            () => {},
            null,
            selectionRect,
        )
        const opts = cardSpy.mock.calls[0]?.[1] as { onRegenerate: () => void }
        opts.onRegenerate()
        await Promise.resolve()
        await Promise.resolve()
        const secondAnchor = cardSpy.mock.calls[1]?.[1]?.anchorRect
        expect(secondAnchor).toBe(selectionRect)
    })
})
