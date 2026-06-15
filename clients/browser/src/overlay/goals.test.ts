// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
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

    it('a new showGoals() dismisses the prior (one popover per root)', () => {
        const root = mkRoot()
        showGoals(root, mkOptions())
        showGoals(root, mkOptions())
        expect(root.querySelectorAll('.gf-goals-pop')).toHaveLength(1)
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
