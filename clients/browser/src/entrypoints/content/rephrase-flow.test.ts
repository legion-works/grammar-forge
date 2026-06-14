// @vitest-environment jsdom
// clients/browser/src/entrypoints/content/rephrase-flow.test.ts
// Item-B flow assertion: the in-content rephrase flow shows the pending
// "Rephrasing…" card, awaits the bridge response, hides the pending
// card, and shows the result card — all in a single user-perceived
// transition (no user interaction, no separate tick). The test pins
// THIS contract against the current openRephraseFor body.

import { describe, expect, it, vi } from 'vitest'
import * as rephraseCard from '@/overlay/rephrase-card'
import * as rephraseButton from '@/overlay/rephrase-button'
import { mountRephraseFlow } from './rephrase'
import type { BridgeClient } from '@/api/client'

vi.mock('@/storage/settings', () => ({
    getSettings: async () => ({
        rephraseTone: '',
        rephraseStyle: '',
        rephraseAlternatives: 1,
    }),
}))

function makeClient(): BridgeClient {
    return {
        rephrase: vi.fn<(req: unknown) => Promise<unknown>>(async () => ({
            original: 'hello world',
            rephrased: 'hi there',
            alternatives: [],
        })),
    } as unknown as BridgeClient
}

describe('rephrase flow — pending → result is a single user-perceived transition', () => {
    it('shows pending, awaits rephrase, hides pending, shows result card', async () => {
        const pendingSpy = vi.spyOn(rephraseCard, 'showRephrasePending').mockReturnValue({
            hide: vi.fn<() => void>(),
        } as unknown as ReturnType<typeof rephraseCard.showRephrasePending>)
        const cardSpy = vi.spyOn(rephraseCard, 'showRephraseCard').mockReturnValue({
            hide: vi.fn<() => void>(),
        } as unknown as ReturnType<typeof rephraseCard.showRephraseCard>)
        vi.spyOn(rephraseButton, 'showRephraseButton').mockReturnValue({
            hide: vi.fn<() => void>(),
        } as unknown as ReturnType<typeof rephraseButton.showRephraseButton>)

        const client = makeClient()
        const overlayRoot = document.createElement('div')
        const el = document.createElement('textarea')
        document.body.appendChild(el)
        el.value = 'hello world'
        // setSelectionRange triggers a non-collapsed selection so
        // resolveSelection returns the whole field as a RephraseScope.
        el.setSelectionRange(0, el.value.length)

        const flow = mountRephraseFlow({
            client,
            overlayRoot: overlayRoot as unknown as ShadowRoot,
            rerun: () => {},
            ctxIsValid: () => true,
            resolveActiveSelection: () => null,
            applyEdit: async () => {},
        })

        flow.rephraseFor(el)
        // Let the synchronous pending.show → client.rephrase → card.show sequence flush.
        await new Promise((r) => setTimeout(r, 10))

        // pending was shown exactly once
        expect(pendingSpy.mock.calls.length).toBe(1)
        // result card was shown exactly once
        expect(cardSpy.mock.calls.length).toBe(1)
        // Call ordering: pending before card
        const pendingOrder = pendingSpy.mock.invocationCallOrder[0] ?? 0
        const cardOrder = cardSpy.mock.invocationCallOrder[0] ?? 0
        expect(pendingOrder).toBeLessThan(cardOrder)

        // Anchor rect on the result card is derived from the same el — the
        // user-perceived "in place" transition. showRephrasePending /
        // showRephraseCard signatures are `(root, { anchorRect, ... })` so
        // the options object is at call[0][1]. The current code calls
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

        flow.stop()
    })
})
