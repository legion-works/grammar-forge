// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderStatusButton } from '@/overlay/status-button'

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}

const ANCHOR = new DOMRect(100, 100, 400, 200)

describe('renderStatusButton', () => {
    it('renders a pill in the shadow root', () => {
        const root = mkRoot()
        renderStatusButton(root, {
            count: 3,
            anchorRect: ANCHOR,
            onClick: vi.fn<() => void>(),
        })
        expect(root.querySelector('.gf-pill')).not.toBeNull()
    })

    it('shows "No issues" with a check when count is 0', () => {
        const root = mkRoot()
        renderStatusButton(root, {
            count: 0,
            anchorRect: ANCHOR,
            onClick: vi.fn<() => void>(),
        })
        const pill = root.querySelector('.gf-pill') as HTMLElement
        expect(pill.textContent).toContain('No issues')
        expect(pill.getAttribute('aria-label')).toBe('No grammar issues')
    })

    it('shows the issue count and pluralises correctly', () => {
        const r1 = mkRoot()
        renderStatusButton(r1, {
            count: 1,
            anchorRect: ANCHOR,
            onClick: vi.fn<() => void>(),
        })
        expect(r1.querySelector('.gf-pill')?.textContent).toMatch(/1 issue(?!s)/)

        const r2 = mkRoot()
        renderStatusButton(r2, {
            count: 5,
            anchorRect: ANCHOR,
            onClick: vi.fn<() => void>(),
        })
        expect(r2.querySelector('.gf-pill')?.textContent).toContain('5 issues')
    })

    it('surfaces the per-category summary when provided', () => {
        const root = mkRoot()
        renderStatusButton(root, {
            count: 3,
            anchorRect: ANCHOR,
            byCategory: { spelling: 2, grammar: 1 },
            onClick: vi.fn<() => void>(),
        })
        const pill = root.querySelector('.gf-pill') as HTMLElement
        expect(pill.textContent).toContain('2 spelling')
        expect(pill.textContent).toContain('1 grammar')
    })

    it('mousedown does not steal focus', () => {
        const root = mkRoot()
        const onClick = vi.fn<() => void>()
        renderStatusButton(root, { count: 2, anchorRect: ANCHOR, onClick })
        const pill = root.querySelector('.gf-pill') as HTMLElement
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
        const prevented = !pill.dispatchEvent(ev)
        expect(prevented).toBe(true)
        expect(onClick).not.toHaveBeenCalled()
    })

    it('click fires onClick exactly once', () => {
        const root = mkRoot()
        const onClick = vi.fn<() => void>()
        renderStatusButton(root, { count: 2, anchorRect: ANCHOR, onClick })
        const pill = root.querySelector('.gf-pill') as HTMLElement
        pill.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onClick).toHaveBeenCalledOnce()
    })

    it('re-rendering replaces the prior pill (no leaks)', () => {
        const root = mkRoot()
        renderStatusButton(root, {
            count: 2,
            anchorRect: ANCHOR,
            onClick: vi.fn<() => void>(),
        })
        renderStatusButton(root, {
            count: 3,
            anchorRect: ANCHOR,
            onClick: vi.fn<() => void>(),
        })
        expect(root.querySelectorAll('.gf-pill')).toHaveLength(1)
        expect(root.querySelector('.gf-pill')?.textContent).toContain('3 issues')
    })

    it('destroy() removes the pill', () => {
        const root = mkRoot()
        const handle = renderStatusButton(root, {
            count: 1,
            anchorRect: ANCHOR,
            onClick: vi.fn<() => void>(),
        })
        expect(handle.isMounted()).toBe(true)
        handle.destroy()
        expect(handle.isMounted()).toBe(false)
        expect(root.querySelector('.gf-pill')).toBeNull()
    })
})
