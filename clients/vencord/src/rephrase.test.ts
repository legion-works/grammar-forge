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
