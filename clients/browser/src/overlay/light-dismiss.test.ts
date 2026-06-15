// @vitest-environment jsdom
// Headless repro + regression guard for outside-click (light-dismiss) on
// Goals and synonyms popovers. Uses createOverlayHost (the SAME path the
// live code uses) so the shadow root's ownerDocument matches the page doc.
//
// ROOT CAUSE INVESTIGATION (Issue A, round 5):
//   Goals uses:    document.addEventListener('mousedown', ...)
//   Synonyms uses: doc.addEventListener('mousedown', ...)  where doc = fieldEl.ownerDocument
//   Panel uses:    doc.addEventListener('pointerdown', ...) where doc = root.ownerDocument
//
// In jsdom, document === root.ownerDocument === fieldEl.ownerDocument, so
// all three resolve to the same node and the tests pass. In a real browser
// extension content script the same holds (content scripts run in the page
// context, so `document` IS the page document). The bug is therefore NOT a
// wrong-document issue.
//
// The REAL difference: Goals/synonyms listen for `mousedown`; the panel
// listens for `pointerdown`. A touch or stylus event fires `pointerdown`
// but NOT `mousedown`. More importantly: in Fastmail's compose area the
// click-away is a `pointerdown` event (pointer events are the modern path).
// Goals/synonyms only listen for `mousedown` → they miss `pointerdown`-only
// dismissals. Fix: switch Goals + synonyms to `pointerdown` (matching the
// working panel pattern).
//
// This test file reproduces the bug (mousedown fires, pointerdown does not
// for Goals/synonyms before the fix) and guards the fix.
import { describe, expect, it, vi } from 'vitest'
import { createOverlayHost } from '@/overlay/shadow-host'
import { showGoals, type GoalsOptions } from '@/overlay/goals'
import { showSynonyms, type SynonymsOptions } from '@/overlay/synonyms'
import type { Goals } from '@/api/types'

const ANCHOR = new DOMRect(100, 100, 200, 28)
const baseGoals: Goals = { audience: 'general', formality: 'neutral' }

function mkGoalsOptions(overrides: Partial<GoalsOptions> = {}): GoalsOptions {
    return {
        anchorRect: ANCHOR,
        goals: baseGoals,
        onChange: vi.fn<(g: Goals) => void>(),
        onClose: vi.fn<() => void>(),
        ...overrides,
    }
}

function mkSynOptions(overrides: Partial<SynonymsOptions> = {}): SynonymsOptions {
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

describe('light-dismiss via outside-click (createOverlayHost path)', () => {
    // ── Goals ──────────────────────────────────────────────────────────────

    it('Goals: outside pointerdown fires onClose (the working panel pattern)', async () => {
        const overlay = createOverlayHost()
        const onClose = vi.fn<() => void>()
        showGoals(overlay.root, mkGoalsOptions({ onClose }))
        // Wait for the arm timer (setTimeout 0).
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        // Pointerdown outside the popover → should close.
        document.body.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }),
        )
        expect(onClose).toHaveBeenCalledOnce()
        overlay.destroy()
    })

    it('Goals: pointerdown INSIDE the popover does NOT fire onClose', async () => {
        const overlay = createOverlayHost()
        const onClose = vi.fn<() => void>()
        showGoals(overlay.root, mkGoalsOptions({ onClose }))
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        // Pointerdown on the popover itself → must NOT close.
        const pop = overlay.root.querySelector('.gf-goals-pop') as HTMLElement
        pop.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }),
        )
        expect(onClose).not.toHaveBeenCalled()
        overlay.destroy()
    })

    it('Goals: clicking a seg option (inside) does NOT fire onClose', async () => {
        const overlay = createOverlayHost()
        const onClose = vi.fn<() => void>()
        showGoals(overlay.root, mkGoalsOptions({ onClose }))
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        const seg = overlay.root.querySelector('.gf-seg') as HTMLElement
        seg.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }),
        )
        expect(onClose).not.toHaveBeenCalled()
        overlay.destroy()
    })

    // ── Synonyms ───────────────────────────────────────────────────────────

    it('Synonyms: outside pointerdown fires onClose', async () => {
        const overlay = createOverlayHost()
        const field = document.createElement('textarea')
        document.body.appendChild(field)
        const onClose = vi.fn<() => void>()
        showSynonyms(overlay.root, mkSynOptions({ onClose }))
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        document.body.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }),
        )
        expect(onClose).toHaveBeenCalledOnce()
        field.remove()
        overlay.destroy()
    })

    it('Synonyms: pointerdown INSIDE the popover does NOT fire onClose', async () => {
        const overlay = createOverlayHost()
        const field = document.createElement('textarea')
        document.body.appendChild(field)
        const onClose = vi.fn<() => void>()
        showSynonyms(overlay.root, mkSynOptions({ onClose }))
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        const pop = overlay.root.querySelector('.gf-syn') as HTMLElement
        pop.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }),
        )
        expect(onClose).not.toHaveBeenCalled()
        field.remove()
        overlay.destroy()
    })
})
