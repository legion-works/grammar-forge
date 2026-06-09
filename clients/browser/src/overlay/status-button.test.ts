// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderStatusButton, type StatusButtonOptions } from '@/overlay/status-button'

function translateOf(pill: HTMLElement): { x: number; y: number } {
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(pill.style.transform)
    return m ? { x: parseFloat(m[1]!), y: parseFloat(m[2]!) } : { x: NaN, y: NaN }
}

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
        onRecheck: vi.fn<() => void>(),
        onApplyAll: vi.fn<() => void>(),
        onApplyOne: vi.fn<(i: number) => void>(),
        dragOffset: undefined,
        onDragMove: vi.fn<(o: { dx: number; dy: number }) => void>(),
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

    it('shows an ok badge (✓) and no issue text when count is 0', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 0, corrections: [] }))
        const body = root.querySelector('.gf-pill__body') as HTMLElement
        expect(body.querySelector('.gf-pill__badge--ok')).not.toBeNull()
        expect(body.textContent).not.toContain('issue')
        expect(body.getAttribute('aria-label')).toBe('No grammar issues')
    })

    it('shows a count badge + breakdown bar, no per-category text', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 3, byCategory: { spelling: 2, grammar: 1 } }))
        const body = root.querySelector('.gf-pill__body') as HTMLElement
        // just the number in the badge — the "N issues · M spelling" text moved
        // to the toolbar popup
        expect(body.querySelector('.gf-pill__badge')?.textContent).toBe('3')
        expect(body.textContent).not.toContain('spelling')
        expect(body.querySelectorAll('.gf-pill-bar__stripe')).toHaveLength(2)
    })

    it('collapses to just the power button when disabled (no body / recheck)', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ disabled: true }))
        expect(root.querySelector('.gf-pill--disabled')).not.toBeNull()
        expect(root.querySelector('.gf-pill__power')).not.toBeNull()
        expect(root.querySelector('.gf-pill__body')).toBeNull()
        expect(root.querySelector('.gf-pill__recheck')).toBeNull()
    })

    it('recheck button fires onRecheck', () => {
        const root = mkRoot()
        const onRecheck = vi.fn<() => void>()
        renderStatusButton(root, mkOptions({ onRecheck }))
        ;(root.querySelector('.gf-pill__recheck') as HTMLElement).dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
        expect(onRecheck).toHaveBeenCalledOnce()
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

    it('mousedown on the pill BODY (drag surface) does not steal field focus', () => {
        // Regression: pressing the pill's draggable surface must preventDefault
        // its mousedown so the focused textarea does NOT blur — otherwise the
        // focus-only pill hides itself the instant you grab it, and the drag
        // dies mid-gesture.
        const root = mkRoot()
        renderStatusButton(root, mkOptions())
        const pill = root.querySelector('.gf-pill') as HTMLElement
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
        const prevented = !pill.dispatchEvent(ev)
        expect(prevented).toBe(true)
    })

    it('drag moves the pill from its current style position (no offsetLeft jump)', () => {
        // The pill is position:fixed; its authoritative position is style.left/
        // top (what we set), NOT offsetLeft (layout-derived, may differ → a
        // visual jump at drag start). The drag must start from style.left/top.
        const root = mkRoot()
        // ANCHOR 400×200 → default bottom-right style.left = 500-110-8 = 382,
        // style.top = 300-28-8 = 264.
        renderStatusButton(root, mkOptions())
        const pill = root.querySelector('.gf-pill') as HTMLElement
        expect(translateOf(pill).x).toBe(382)
        expect(translateOf(pill).y).toBe(264)
        pill.dispatchEvent(
            new PointerEvent('pointerdown', { clientX: 200, clientY: 200, bubbles: true }),
        )
        pill.dispatchEvent(
            new PointerEvent('pointermove', { clientX: 230, clientY: 250, bubbles: true }),
        )
        // Moved +30,+50 from the style start (382,264) → 412, 314.
        expect(translateOf(pill).x).toBe(412)
        expect(translateOf(pill).y).toBe(314)
        pill.dispatchEvent(
            new PointerEvent('pointerup', { clientX: 230, clientY: 250, bubbles: true }),
        )
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

    it('renders a category breakdown bar with one stripe per non-zero category', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 4, byCategory: { spelling: 3, grammar: 1 } }))
        const stripes = root.querySelectorAll('.gf-pill-bar__stripe')
        expect(stripes).toHaveLength(2)
        // proportional flex-grow reflects the counts (3 vs 1)
        expect((stripes[0] as HTMLElement).style.flexGrow).toBe('3')
        expect((stripes[1] as HTMLElement).style.flexGrow).toBe('1')
    })

    it('renders no breakdown bar when there are no issues', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 0, corrections: [], byCategory: {} }))
        expect(root.querySelector('.gf-pill-bar')).toBeNull()
    })

    it('wraps the issue count in an aria-live polite region', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 3 }))
        const live = root.querySelector('[aria-live="polite"]') as HTMLElement
        expect(live).not.toBeNull()
        expect(live.getAttribute('aria-atomic')).toBe('true')
        expect(live.textContent).toContain('3')
    })

    it('a drag offset within the field shifts the pill (bound to the field)', () => {
        const root = mkRoot()
        // ANCHOR is 400×200 (right=500,bottom=300). A small offset keeps the
        // pill inside the field box. Default bottom-right = (382, 264); a
        // (-50,-40) offset moves it up/left, still within the field.
        renderStatusButton(root, mkOptions({ dragOffset: { dx: -50, dy: -40 } }))
        const pill = root.querySelector('.gf-pill') as HTMLElement
        expect(translateOf(pill).x).toBe(332)
        expect(translateOf(pill).y).toBe(224)
    })

    it('a drag offset cannot push the pill outside the field box (clamped to field)', () => {
        const root = mkRoot()
        // A big positive offset would put the pill past the field's
        // bottom-right; the field-clamp pins it to the field's far edge.
        // maxLeft = 500-110-8 = 382 ; maxTop = 300-28-8 = 264.
        renderStatusButton(root, mkOptions({ dragOffset: { dx: 500, dy: 500 } }))
        const pill = root.querySelector('.gf-pill') as HTMLElement
        expect(translateOf(pill).x).toBe(382)
        expect(translateOf(pill).y).toBe(264)
    })

    it('reposition() re-anchors the pill to a fresh field rect with the live offset', () => {
        const root = mkRoot()
        const handle = renderStatusButton(root, mkOptions({ dragOffset: { dx: 10, dy: 20 } }))
        const pill = root.querySelector('.gf-pill') as HTMLElement
        // Re-anchor to a field that has scrolled up by 100px.
        handle.reposition(new DOMRect(100, 0, 400, 200))
        // right=500, bottom=200 → 500-110-8+10 = 392 ; 200-28-8+20 = 184
        // (both within the new field box: maxLeft=382? no — left 392 > maxLeft
        // 382 → clamped to 382; top 184 < maxTop=164? maxTop=200-28-8=164, so
        // 184 > 164 → clamped to 164).
        expect(translateOf(pill).x).toBe(382)
        expect(translateOf(pill).y).toBe(164)
    })

    it('dragging the pill past the threshold reports a new accumulated offset', () => {
        const root = mkRoot()
        const onDragMove = vi.fn<(o: { dx: number; dy: number }) => void>()
        renderStatusButton(root, mkOptions({ onDragMove }))
        const pill = root.querySelector('.gf-pill') as HTMLElement
        pill.dispatchEvent(
            new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }),
        )
        pill.dispatchEvent(
            new PointerEvent('pointermove', { clientX: 140, clientY: 130, bubbles: true }),
        )
        pill.dispatchEvent(
            new PointerEvent('pointerup', { clientX: 140, clientY: 130, bubbles: true }),
        )
        expect(onDragMove).toHaveBeenCalledTimes(1)
        const off = onDragMove.mock.calls[0]![0]
        // started from a zero offset, so the reported offset == the drag delta.
        expect(off.dx).toBe(40)
        expect(off.dy).toBe(30)
    })

    it('a drag accumulates on top of the seeded offset', () => {
        const root = mkRoot()
        const onDragMove = vi.fn<(o: { dx: number; dy: number }) => void>()
        renderStatusButton(root, mkOptions({ onDragMove, dragOffset: { dx: 5, dy: 7 } }))
        const pill = root.querySelector('.gf-pill') as HTMLElement
        pill.dispatchEvent(
            new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }),
        )
        pill.dispatchEvent(
            new PointerEvent('pointermove', { clientX: 110, clientY: 120, bubbles: true }),
        )
        pill.dispatchEvent(
            new PointerEvent('pointerup', { clientX: 110, clientY: 120, bubbles: true }),
        )
        const off = onDragMove.mock.calls[0]![0]
        // seeded (5,7) + delta (10,20) = (15,27)
        expect(off.dx).toBe(15)
        expect(off.dy).toBe(27)
    })

    it('renders hidden when initiallyVisible is false (focus-only pill)', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ initiallyVisible: false }))
        const pill = root.querySelector('.gf-pill') as HTMLElement
        expect(pill.classList.contains('gf-pill--hidden')).toBe(true)
    })

    it('renders visible by default (initiallyVisible omitted)', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions())
        const pill = root.querySelector('.gf-pill') as HTMLElement
        expect(pill.classList.contains('gf-pill--hidden')).toBe(false)
    })

    it('setVisible toggles the hidden class', () => {
        const root = mkRoot()
        const handle = renderStatusButton(root, mkOptions({ initiallyVisible: false }))
        const pill = root.querySelector('.gf-pill') as HTMLElement
        expect(pill.classList.contains('gf-pill--hidden')).toBe(true)
        handle.setVisible(true)
        expect(pill.classList.contains('gf-pill--hidden')).toBe(false)
        handle.setVisible(false)
        expect(pill.classList.contains('gf-pill--hidden')).toBe(true)
    })

    it('a click without movement does NOT start a drag (buttons still work)', () => {
        const root = mkRoot()
        const onDragMove = vi.fn<(o: { dx: number; dy: number }) => void>()
        const onTogglePower = vi.fn<() => void>()
        renderStatusButton(root, mkOptions({ onDragMove, onTogglePower }))
        const power = root.querySelector('.gf-pill__power') as HTMLElement
        power.dispatchEvent(
            new PointerEvent('pointerdown', { clientX: 10, clientY: 10, bubbles: true }),
        )
        power.dispatchEvent(
            new PointerEvent('pointerup', { clientX: 11, clientY: 10, bubbles: true }),
        )
        power.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onDragMove).not.toHaveBeenCalled()
        expect(onTogglePower).toHaveBeenCalledTimes(1)
    })

    it('update() refreshes the badge + stripe in place, reusing the same pill node', () => {
        const root = mkRoot()
        const handle = renderStatusButton(
            root,
            mkOptions({ count: 2, byCategory: { spelling: 2 } }),
        )
        const pillBefore = root.querySelector('.gf-pill')
        handle.update(mkOptions({ count: 5, byCategory: { spelling: 3, grammar: 2 } }))
        const pillAfter = root.querySelector('.gf-pill')
        expect(pillAfter).toBe(pillBefore)
        expect(root.querySelector('.gf-pill__badge')?.textContent).toBe('5')
        expect(root.querySelectorAll('.gf-pill-bar__stripe')).toHaveLength(2)
    })

    it('update() switches to the clean state when count drops to 0', () => {
        const root = mkRoot()
        const handle = renderStatusButton(root, mkOptions({ count: 3 }))
        handle.update(mkOptions({ count: 0, corrections: [], byCategory: {} }))
        expect(root.querySelector('.gf-pill__badge--ok')).not.toBeNull()
    })

    it('update() preserves visibility state set via initiallyVisible', () => {
        const root = mkRoot()
        const handle = renderStatusButton(root, mkOptions({ count: 1, initiallyVisible: false }))
        expect(root.querySelector('.gf-pill')?.classList.contains('gf-pill--hidden')).toBe(true)
        handle.update(mkOptions({ count: 2 }))
        expect(root.querySelector('.gf-pill')?.classList.contains('gf-pill--hidden')).toBe(true)
    })

    it('positions the pill via transform translate, not left/top', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 1 }))
        const pill = root.querySelector('.gf-pill') as HTMLElement
        expect(pill.style.transform).toMatch(/translate/)
    })
})
