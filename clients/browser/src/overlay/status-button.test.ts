// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderStatusButton, type StatusButtonOptions } from '@/overlay/status-button'

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}

const ANCHOR = new DOMRect(100, 100, 400, 200)

function mkOptions(overrides: Partial<StatusButtonOptions> = {}): StatusButtonOptions {
    return {
        count: 3,
        anchorRect: ANCHOR,
        disabled: false,
        corrections: [
            {
                category: 'grammar',
                diffOriginal: 'was',
                diffCorrected: 'were',
                diffIsDeletion: false,
            },
            {
                category: 'grammar',
                diffOriginal: 'are',
                diffCorrected: 'is',
                diffIsDeletion: false,
            },
        ],
        onFocusField: vi.fn<() => void>(),
        onTogglePower: vi.fn<() => void>(),
        onApplyAll: vi.fn<() => void>(),
        onApplyOne: vi.fn<(i: number) => void>(),
        ...overrides,
    }
}

describe('renderStatusButton', () => {
    it('renders a pill with a power button and a body', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions())
        expect(root.querySelector('.gf-pill')).not.toBeNull()
        expect(root.querySelector('.gf-pill__power')).not.toBeNull()
        expect(root.querySelector('.gf-pill__body')).not.toBeNull()
    })

    it('shows "No issues" with a check when count is 0', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 0, corrections: [] }))
        const body = root.querySelector('.gf-pill__body') as HTMLElement
        expect(body.textContent).toContain('No issues')
        expect(body.getAttribute('aria-label')).toBe('No grammar issues')
    })

    it('shows the issue count and per-category summary', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 3, byCategory: { spelling: 2, grammar: 1 } }))
        const body = root.querySelector('.gf-pill__body') as HTMLElement
        expect(body.textContent).toContain('3 issues')
        expect(body.textContent).toContain('2 spelling')
        expect(body.textContent).toContain('1 grammar')
    })

    it('collapses to just the power button when disabled', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ disabled: true }))
        expect(root.querySelector('.gf-pill--disabled')).not.toBeNull()
        expect(root.querySelector('.gf-pill__power')).not.toBeNull()
        expect(root.querySelector('.gf-pill__body')).toBeNull()
    })

    it('power button fires onTogglePower', () => {
        const root = mkRoot()
        const onTogglePower = vi.fn<() => void>()
        renderStatusButton(root, mkOptions({ onTogglePower }))
        ;(root.querySelector('.gf-pill__power') as HTMLElement).dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
        expect(onTogglePower).toHaveBeenCalledOnce()
    })

    it('body click fires onFocusField', () => {
        const root = mkRoot()
        const onFocusField = vi.fn<() => void>()
        renderStatusButton(root, mkOptions({ onFocusField }))
        ;(root.querySelector('.gf-pill__body') as HTMLElement).dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
        expect(onFocusField).toHaveBeenCalledOnce()
    })

    it('hovering the pill opens a panel with a diff row per correction + Apply all', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions())
        const pill = root.querySelector('.gf-pill') as HTMLElement
        pill.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
        const panel = root.querySelector('.gf-pill-panel') as HTMLElement
        expect(panel).not.toBeNull()
        expect(panel.querySelectorAll('.gf-pill-panel__row')).toHaveLength(2)
        expect(panel.querySelector('.gf-pill-panel__apply-all')).not.toBeNull()
        // the row shows the red->green diff
        expect(panel.querySelector('.gf-diff__old')?.textContent).toBe('was')
        expect(panel.querySelector('.gf-diff__new')?.textContent).toBe('were')
    })

    it('Apply all in the panel fires onApplyAll', () => {
        const root = mkRoot()
        const onApplyAll = vi.fn<() => void>()
        renderStatusButton(root, mkOptions({ onApplyAll }))
        const pill = root.querySelector('.gf-pill') as HTMLElement
        pill.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
        ;(root.querySelector('.gf-pill-panel__apply-all') as HTMLElement).dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
        expect(onApplyAll).toHaveBeenCalledOnce()
    })

    it('clicking a panel row fires onApplyOne with its index', () => {
        const root = mkRoot()
        const onApplyOne = vi.fn<(i: number) => void>()
        renderStatusButton(root, mkOptions({ onApplyOne }))
        const pill = root.querySelector('.gf-pill') as HTMLElement
        pill.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
        const rows = root.querySelectorAll('.gf-pill-panel__row')
        ;(rows[1] as HTMLElement).dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
        expect(onApplyOne).toHaveBeenCalledWith(1)
    })

    it('does not open a panel when there are no corrections', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 0, corrections: [] }))
        const pill = root.querySelector('.gf-pill') as HTMLElement
        pill.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
        expect(root.querySelector('.gf-pill-panel')).toBeNull()
    })

    it('mousedown on the pill power does not steal focus', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions())
        const power = root.querySelector('.gf-pill__power') as HTMLElement
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
        const prevented = !power.dispatchEvent(ev)
        expect(prevented).toBe(true)
    })

    it('re-rendering replaces the prior pill + panel (no leaks)', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 2 }))
        renderStatusButton(root, mkOptions({ count: 3 }))
        expect(root.querySelectorAll('.gf-pill')).toHaveLength(1)
        expect(root.querySelectorAll('.gf-pill-panel')).toHaveLength(0)
    })

    it('destroy() removes the pill and any open panel', () => {
        const root = mkRoot()
        const handle = renderStatusButton(root, mkOptions())
        const pill = root.querySelector('.gf-pill') as HTMLElement
        pill.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
        expect(handle.isMounted()).toBe(true)
        handle.destroy()
        expect(handle.isMounted()).toBe(false)
        expect(root.querySelector('.gf-pill')).toBeNull()
        expect(root.querySelector('.gf-pill-panel')).toBeNull()
    })
})
