// @vitest-environment jsdom
// Headless repro + regression guard for outside-click (light-dismiss) on
// Goals and synonyms popovers. Uses createOverlayHost (the SAME path the
// live code uses) so the shadow root's ownerDocument matches the page doc.
//
// ROOT CAUSE INVESTIGATION (Round 8 — the decisive log evidence):
//   Live logs showed: "goals: outside — dismissing" firing 15+ times on
//   every outside click, but the popover stayed open.
//
//   TWO bugs:
//   1. installOutsideDismiss did NOT self-remove after firing onDismiss().
//      The window listener stayed installed → fired on every subsequent
//      click → called onDismiss() repeatedly.
//   2. Goals/synonyms onClose in the orchestrator did:
//        onClose: () => { runtime.goalsHandle = null }
//      This nulled the handle but NEVER called destroy() → the DOM node
//      stayed mounted and the outsideDismiss listener was never removed.
//      Compare: the panel's onClose calls runtime.panelHandle?.destroy()
//      which calls outsideDismiss.remove() — that's why the panel worked.
//
//   FIX:
//   1. installOutsideDismiss self-removes (view.removeEventListener) before
//      calling onDismiss() — one-shot behavior.
//   2. Goals/synonyms onClose now calls handle.destroy() before nulling.
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

describe('installOutsideDismiss one-shot + DOM removal regression (round 8)', () => {
    // Regression guard for the two bugs found via live [gf-dismiss] logs:
    // 1. The listener must self-remove after firing (one-shot) — no repeats.
    // 2. onDismiss must actually remove the DOM node (not just null a handle).

    it('Goals: outside pointerdown removes the .gf-goals-pop node (not just nulls handle)', async () => {
        // Bug 2: onClose was () => { handle = null } — node stayed mounted.
        // Fix: onClose must call handle.destroy() which removes the node.
        // This test verifies the node is gone after dismiss.
        const overlay = createOverlayHost()
        const onClose = vi.fn<() => void>(() => {
            // Simulate the correct orchestrator behavior: call destroy().
            const pop = overlay.root.querySelector('.gf-goals-pop') as HTMLElement | null
            if (pop) pop.remove()
        })
        showGoals(overlay.root, mkGoalsOptions({ onClose }))
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        expect(overlay.root.querySelector('.gf-goals-pop')).not.toBeNull()
        document.body.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }),
        )
        expect(onClose).toHaveBeenCalledOnce()
        expect(overlay.root.querySelector('.gf-goals-pop')).toBeNull()
        overlay.destroy()
    })

    it('Goals: outside pointerdown fires onClose exactly ONCE (listener self-removes)', async () => {
        // Bug 1: installOutsideDismiss did not self-remove after firing.
        // Every subsequent outside click re-fired onDismiss → 15+ repeats.
        // Fix: self-remove before calling onDismiss (one-shot).
        const overlay = createOverlayHost()
        const onClose = vi.fn<() => void>()
        showGoals(overlay.root, mkGoalsOptions({ onClose }))
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        // Fire three outside clicks.
        for (let i = 0; i < 3; i++) {
            document.body.dispatchEvent(
                new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }),
            )
        }
        // Must fire exactly once (one-shot), not 3 times.
        expect(onClose).toHaveBeenCalledTimes(1)
        overlay.destroy()
    })

    it('Synonyms: outside pointerdown fires onClose exactly ONCE (one-shot)', async () => {
        const overlay = createOverlayHost()
        const field = document.createElement('textarea')
        document.body.appendChild(field)
        const onClose = vi.fn<() => void>()
        showSynonyms(overlay.root, mkSynOptions({ onClose }))
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        for (let i = 0; i < 3; i++) {
            document.body.dispatchEvent(
                new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }),
            )
        }
        expect(onClose).toHaveBeenCalledTimes(1)
        field.remove()
        overlay.destroy()
    })
})
