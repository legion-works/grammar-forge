// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showGoals, type GoalsOptions } from '@/overlay/goals'
import type { Goals } from '@/api/types'

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}

const ANCHOR = new DOMRect(100, 100, 200, 28)

const baseGoals: Goals = { audience: 'general', formality: 'neutral' }

function mkOptions(overrides: Partial<GoalsOptions> = {}): GoalsOptions {
    return {
        anchorRect: ANCHOR,
        goals: baseGoals,
        onChange: vi.fn<(g: Goals) => void>(),
        onClose: vi.fn<() => void>(),
        ...overrides,
    }
}

describe('showGoals (W2b goals popover)', () => {
    it('mounts a .gf-goals-pop in the shadow root', () => {
        const root = mkRoot()
        showGoals(root, mkOptions())
        expect(root.querySelector('.gf-goals-pop')).not.toBeNull()
    })

    it('marks the CURRENT audience option as active (.is-active + aria-checked=true)', () => {
        const root = mkRoot()
        const goals: Goals = { audience: 'expert', formality: 'neutral' }
        showGoals(root, mkOptions({ goals }))
        const audience = root.querySelectorAll('.gf-goals__row')[0] as HTMLElement
        const segs = audience.querySelectorAll('.gf-seg')
        const labels = Array.from(segs).map((s) => s.textContent)
        const active = audience.querySelector('.gf-seg.is-active') as HTMLElement
        expect(active.textContent).toBe('Expert')
        expect(active.getAttribute('aria-checked')).toBe('true')
        // Sanity: the other two audience options are NOT active.
        expect(labels).toEqual(['General', 'Informed', 'Expert'])
        const inactiveAriaChecked = Array.from(segs)
            .filter((s) => s !== active)
            .map((s) => s.getAttribute('aria-checked'))
        expect(inactiveAriaChecked).toEqual(['false', 'false'])
    })

    it('marks the CURRENT formality option as active', () => {
        const root = mkRoot()
        const goals: Goals = { audience: 'general', formality: 'informal' }
        showGoals(root, mkOptions({ goals }))
        const formality = root.querySelectorAll('.gf-goals__row')[1] as HTMLElement
        const active = formality.querySelector('.gf-seg.is-active') as HTMLElement
        expect(active.textContent).toBe('Informal')
    })

    it('renders the side-effect hint about informal muting style', () => {
        const root = mkRoot()
        showGoals(root, mkOptions())
        const note = root.querySelector('.gf-goals__note') as HTMLElement
        expect(note.textContent).toContain('Informal mutes style')
        expect(note.textContent).toContain('formal raises the bar')
    })

    it('clicking a new audience option fires onChange with the merged goals', () => {
        const root = mkRoot()
        const onChange = vi.fn<(g: Goals) => void>()
        const goals: Goals = { audience: 'general', formality: 'neutral' }
        showGoals(root, mkOptions({ goals, onChange }))
        const audience = root.querySelectorAll('.gf-goals__row')[0] as HTMLElement
        const informed = Array.from(audience.querySelectorAll('.gf-seg')).find(
            (b) => b.textContent === 'Informed',
        ) as HTMLElement
        informed.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onChange).toHaveBeenCalledTimes(1)
        expect(onChange.mock.calls[0]![0]).toEqual({ audience: 'informed', formality: 'neutral' })
    })

    it('clicking a new formality option fires onChange (the EFFECT — muted style + rephrase tone — is in view-model)', () => {
        const root = mkRoot()
        const onChange = vi.fn<(g: Goals) => void>()
        showGoals(root, mkOptions({ onChange }))
        const formality = root.querySelectorAll('.gf-goals__row')[1] as HTMLElement
        const formal = Array.from(formality.querySelectorAll('.gf-seg')).find(
            (b) => b.textContent === 'Formal',
        ) as HTMLElement
        formal.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onChange).toHaveBeenCalledWith({ audience: 'general', formality: 'formal' })
    })

    it('clicking the SAME active option is a no-op (no onChange)', () => {
        const root = mkRoot()
        const onChange = vi.fn<(g: Goals) => void>()
        showGoals(root, mkOptions({ onChange }))
        const audience = root.querySelectorAll('.gf-goals__row')[0] as HTMLElement
        const general = audience.querySelector('.gf-seg.is-active') as HTMLElement
        general.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onChange).not.toHaveBeenCalled()
    })

    it('the just-clicked option becomes active immediately (optimistic UI)', () => {
        const root = mkRoot()
        showGoals(root, mkOptions())
        const audience = root.querySelectorAll('.gf-goals__row')[0] as HTMLElement
        const expert = Array.from(audience.querySelectorAll('.gf-seg')).find(
            (b) => b.textContent === 'Expert',
        ) as HTMLElement
        expert.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(expert.classList.contains('is-active')).toBe(true)
        expect(expert.getAttribute('aria-checked')).toBe('true')
    })

    it('Esc fires onClose (caller tears down the popover)', () => {
        const root = mkRoot()
        const onClose = vi.fn<() => void>()
        showGoals(root, mkOptions({ onClose }))
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        expect(onClose).toHaveBeenCalledOnce()
    })

    it('P1-7: Esc still fires onClose on a host page that stopPropagation()s at window capture', () => {
        // Regression for the documented dismiss.ts failure mode: a host page
        // installs `window.addEventListener('keydown', ..., {capture:true})`
        // + stopPropagation(), which would starve a document-BUBBLE listener
        // entirely (propagation never reaches document). Esc must be
        // registered on window capture itself so it fires regardless of
        // host stopPropagation and regardless of listener registration order.
        const hostListener = (e: KeyboardEvent): void => e.stopPropagation()
        window.addEventListener('keydown', hostListener, { capture: true })
        try {
            const root = mkRoot()
            const onClose = vi.fn<() => void>()
            showGoals(root, mkOptions({ onClose }))
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
            expect(onClose).toHaveBeenCalledOnce()
        } finally {
            window.removeEventListener('keydown', hostListener, { capture: true })
        }
    })

    it('destroy() removes the Esc listener (no leak — a later Esc does not double-fire onClose)', () => {
        const root = mkRoot()
        const onClose = vi.fn<() => void>()
        const handle = showGoals(root, mkOptions({ onClose }))
        handle.destroy()
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        expect(onClose).not.toHaveBeenCalled()
    })

    describe('P1-5: focus restoration on close', () => {
        let field: HTMLTextAreaElement
        beforeEach(() => {
            field = document.createElement('textarea')
            document.body.appendChild(field)
            field.focus()
        })
        afterEach(() => {
            field.remove()
        })

        it('destroy() (programmatic close) restores focus to the field that had it before the popover opened', () => {
            const root = mkRoot()
            expect(document.activeElement).toBe(field)
            const handle = showGoals(root, mkOptions())
            handle.destroy()
            expect(document.activeElement).toBe(field)
        })

        it('Esc restores focus to the field', () => {
            const root = mkRoot()
            showGoals(root, mkOptions())
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
            expect(document.activeElement).toBe(field)
        })

        it('does not throw when the previously-focused element was removed from the DOM before close', () => {
            const root = mkRoot()
            const handle = showGoals(root, mkOptions())
            field.remove()
            expect(() => handle.destroy()).not.toThrow()
        })
    })

    it('a new showGoals() dismisses the prior (one popover per root)', () => {
        const root = mkRoot()
        showGoals(root, mkOptions())
        showGoals(root, mkOptions())
        expect(root.querySelectorAll('.gf-goals-pop')).toHaveLength(1)
    })

    it('a re-open destroys the PREVIOUS handle, not just its DOM (item 3: no orphaned window listeners)', async () => {
        // ROOT CAUSE: destroyExisting() used to only
        // querySelectorAll('.gf-goals-pop').remove() — the prior handle's
        // destroy() (which removes its installOutsideDismiss window
        // pointerdown listener + installEscapeCapture window keydown
        // listener, and restores focus) never ran. Each re-open orphaned
        // one instance's listeners. Fixed via a per-root registry
        // (mirrors popover.ts / rephrase-card.ts) that destroyExisting()
        // now drains through real destroy() calls.
        const root = mkRoot()
        const onClose1 = vi.fn<() => void>()
        const first = showGoals(root, mkOptions({ onClose: onClose1 }))
        expect(first.isOpen()).toBe(true)
        // installOutsideDismiss arms its window pointerdown listener after
        // a setTimeout(0) — wait a tick so the FIRST popover's listener is
        // actually installed (the state a real re-open would find), not
        // just a pending arm timer.
        await new Promise<void>((r) => setTimeout(r, 0))

        const removeSpy = vi.spyOn(window, 'removeEventListener')
        const onClose2 = vi.fn<() => void>()
        const second = showGoals(root, mkOptions({ onClose: onClose2 }))

        // The first handle must be FULLY torn down, not just its DOM node.
        expect(first.isOpen()).toBe(false)
        const removedTypes = removeSpy.mock.calls.map((c) => c[0])
        expect(removedTypes).toContain('pointerdown')
        expect(removedTypes).toContain('keydown')
        removeSpy.mockRestore()

        // Let the SECOND popover's own arm timer fire, then verify an
        // outside pointerdown fires ONLY the live (second) popover's
        // onClose — a leaked first-handle listener would double-fire (or
        // fire the wrong, already-torn-down instance's callback).
        await new Promise<void>((r) => setTimeout(r, 0))
        document.body.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }),
        )
        expect(onClose1).not.toHaveBeenCalled()
        expect(onClose2).toHaveBeenCalledTimes(1)
        expect(second.isOpen()).toBe(true)
    })

    it('destroy() removes the popover; isOpen() reports false afterwards', () => {
        const root = mkRoot()
        const handle = showGoals(root, mkOptions())
        expect(handle.isOpen()).toBe(true)
        handle.destroy()
        expect(handle.isOpen()).toBe(false)
        expect(root.querySelector('.gf-goals-pop')).toBeNull()
    })

    it('destroy() is idempotent (safe to call twice)', () => {
        const root = mkRoot()
        const handle = showGoals(root, mkOptions())
        handle.destroy()
        expect(() => handle.destroy()).not.toThrow()
    })

    it('positioning: places the popover anchored to the rect (below by default, viewport-clamped)', () => {
        const root = mkRoot()
        showGoals(root, mkOptions())
        const pop = root.querySelector('.gf-goals-pop') as HTMLElement
        const top = parseInt(pop.style.top, 10)
        const left = parseInt(pop.style.left, 10)
        expect(Number.isFinite(top)).toBe(true)
        expect(Number.isFinite(left)).toBe(true)
        // Right-aligned to the anchor's right edge (anchor.right - popover.width).
        expect(left).toBeLessThanOrEqual(ANCHOR.right)
    })
})
