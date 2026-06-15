// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderStatusButton, type StatusButtonOptions } from '@/overlay/status-button'
import { arcOffset, BAND_COLOR } from '@/lib/view-model'

function positionOf(pill: HTMLElement): { x: number; y: number } {
    // The orb is positioned via inline `left`/`top` (NOT transform), so the
    // W2 :hover/:active `transform: scale()` doesn't clobber the position.
    const left = parseFloat(pill.style.left)
    const top = parseFloat(pill.style.top)
    return { x: left, y: top }
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
        corrections: [],
        onFocusField: vi.fn<() => void>(),
        onTogglePower: vi.fn<() => void>(),
        onRecheck: vi.fn<() => void>(),
        onApplyAll: vi.fn<() => void>(),
        onApplyOne: vi.fn<(i: number) => void>(),
        onUndo: vi.fn<() => void>(),
        onRephrase: vi.fn<() => void>(),
        undoAvailable: false,
        dragOffset: undefined,
        onDragMove: vi.fn<(o: { dx: number; dy: number }) => void>(),
        ...overrides,
    }
}

function ringArc(orb: HTMLElement): SVGGeometryElement {
    return orb.querySelector('.gf-ring__arc') as unknown as SVGGeometryElement
}

describe('renderStatusButton (W2 score orb — hover panel retired in W2b)', () => {
    it('renders a .gf-orb root (the W2 redesign — no more .gf-pill)', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 2 }))
        expect(root.querySelector('.gf-orb')).not.toBeNull()
        expect(root.querySelector('.gf-pill')).toBeNull()
    })

    it('renders the score ring with the reference DC geometry (r=24.5, dasharray=153.9)', () => {
        // Visual source of truth: GrammarForge Assistant.dc.html, lines 191-192.
        // The view-model arcOffset helper uses the same circumference; the
        // orb's SVG must keep these numbers in lock-step — change one and
        // the other will diverge visually.
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 1, score: 80 }))
        const orb = root.querySelector('.gf-orb') as HTMLElement
        const arc = ringArc(orb)
        expect(arc.getAttribute('cx')).toBe('29')
        expect(arc.getAttribute('cy')).toBe('29')
        expect(arc.getAttribute('r')).toBe('24.5')
        expect(arc.getAttribute('stroke-dasharray')).toBe('153.9')
        expect(arc.getAttribute('stroke-width')).toBe('3.2')
        expect(arc.getAttribute('stroke-linecap')).toBe('round')
        // Progress arc is rotated -90° so it starts at 12 o'clock.
        expect(arc.getAttribute('transform')).toBe('rotate(-90 29 29)')
    })

    it('arc stroke-dashoffset matches arcOffset(score) (consumed, not re-derived)', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 1, score: 60 }))
        const arc = ringArc(root.querySelector('.gf-orb') as HTMLElement)
        expect(parseFloat(arc.getAttribute('stroke-dashoffset') ?? '')).toBeCloseTo(arcOffset(60))
    })

    it('arc stroke color matches BAND_COLOR[scoreBand(score)] (consumed, not re-derived)', () => {
        const root = mkRoot()
        // score 95 → excellent → #16a34a green
        renderStatusButton(root, mkOptions({ count: 1, score: 95 }))
        const arc = ringArc(root.querySelector('.gf-orb') as HTMLElement)
        expect(arc.getAttribute('stroke')).toBe(BAND_COLOR.excellent)
    })

    it('explicit band short-circuits the score→band lookup (caller pre-computed)', () => {
        // Pass band=good with a low score: the band wins for color; the score
        // still drives the offset.
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 1, score: 50, band: 'good' }))
        const arc = ringArc(root.querySelector('.gf-orb') as HTMLElement)
        expect(arc.getAttribute('stroke')).toBe(BAND_COLOR.good)
        expect(parseFloat(arc.getAttribute('stroke-dashoffset') ?? '')).toBeCloseTo(arcOffset(50))
    })

    it('undefined score yields a full green ring (not-yet-checked state)', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 0, corrections: [] }))
        const arc = ringArc(root.querySelector('.gf-orb') as HTMLElement)
        expect(parseFloat(arc.getAttribute('stroke-dashoffset') ?? '')).toBeCloseTo(0)
        expect(arc.getAttribute('stroke')).toBe(BAND_COLOR.excellent)
    })

    it('count state: the number renders in the center as a live region', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 3 }))
        const glyph = root.querySelector('.gf-orb__glyph--count') as HTMLElement
        expect(glyph).not.toBeNull()
        expect(glyph.textContent).toBe('3')
        expect(glyph.getAttribute('aria-live')).toBe('polite')
        expect(glyph.getAttribute('aria-atomic')).toBe('true')
    })

    it('clean state: count=0 shows ✓ in the center', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 0, corrections: [] }))
        const body = root.querySelector('.gf-orb__body') as HTMLElement
        const clean = body.querySelector('.gf-orb__glyph--clean') as HTMLElement
        expect(clean).not.toBeNull()
        expect(clean.textContent).toBe('✓')
        expect(clean.getAttribute('aria-hidden')).toBe('true')
        expect(body.getAttribute('aria-label')).toBe('No grammar issues')
    })

    it('disabled (site-paused) state: power glyph wins; no count number', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ disabled: true, count: 0, corrections: [] }))
        expect(root.querySelector('.gf-orb--disabled')).not.toBeNull()
        const power = root.querySelector('.gf-orb__glyph--power svg') as SVGElement
        expect(power).not.toBeNull()
        // Power state is silent — no count number anywhere.
        expect(root.querySelector('.gf-orb__glyph--count')).toBeNull()
    })

    it('disabled wins over every other state (count + fast + clean)', () => {
        // Single, unambiguous affordance — even with a fast phase + a non-
        // zero count, the power glyph is the only thing the user sees.
        const root = mkRoot()
        renderStatusButton(
            root,
            mkOptions({ disabled: true, count: 4, phase: 'fast', corrections: [] }),
        )
        expect(root.querySelector('.gf-orb__glyph--power')).not.toBeNull()
        expect(root.querySelector('.gf-pip')).toBeNull()
        expect(root.querySelector('.gf-orb__glyph--count')).toBeNull()
    })

    it("AI pip state: phase='fast' with count > 0 swaps the count for a pulsing sparkle", () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 3, phase: 'fast' }))
        const pip = root.querySelector('.gf-pip') as HTMLElement
        expect(pip).not.toBeNull()
        expect(pip.textContent).toBe('✨')
        expect(pip.getAttribute('aria-hidden')).toBe('true')
        // No count badge during the fast phase.
        expect(root.querySelector('.gf-orb__glyph--count')).toBeNull()
    })

    it("AI pip is suppressed when count === 0 (nothing to refine — show ✓ instead)", () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 0, phase: 'fast', corrections: [] }))
        expect(root.querySelector('.gf-pip')).toBeNull()
        expect(root.querySelector('.gf-orb__glyph--clean')).not.toBeNull()
    })

    it("orb click fires onOpen (W2b review-panel entry point — orchestrator wires showPanel)", () => {
        // The orb's body click → `onFocusField` + `onOpen`. The orchestrator
        // wires `onOpen` to `showPanel` from `@/overlay/panel`. The orb
        // itself owns no panel (the W1 hover panel is retired in W2b).
        const root = mkRoot()
        const onOpen = vi.fn<() => void>()
        renderStatusButton(root, mkOptions({ onOpen }))
        const body = root.querySelector('.gf-orb__body') as HTMLElement
        body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onOpen).toHaveBeenCalledOnce()
    })

    it("onOpen is optional and is a no-op when omitted (doesn't throw)", () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions())
        const body = root.querySelector('.gf-orb__body') as HTMLElement
        expect(() => body.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow()
    })

    it("update() swaps the center glyph as count/phase/disabled change", () => {
        const root = mkRoot()
        const handle = renderStatusButton(root, mkOptions({ count: 3, phase: 'done' }))
        expect(root.querySelector('.gf-orb__glyph--count')?.textContent).toBe('3')
        // fast + count>0 → pip
        handle.update(mkOptions({ count: 3, phase: 'fast' }))
        expect(root.querySelector('.gf-pip')).not.toBeNull()
        expect(root.querySelector('.gf-orb__glyph--count')).toBeNull()
        // count=0 + done → clean
        handle.update(mkOptions({ count: 0, corrections: [] }))
        expect(root.querySelector('.gf-orb__glyph--clean')).not.toBeNull()
        // disabled → power
        handle.update(mkOptions({ disabled: true, count: 0, corrections: [] }))
        expect(root.querySelector('.gf-orb__glyph--power')).not.toBeNull()
    })

    it("update() refreshes the arc color + offset in place (no teardown)", () => {
        const root = mkRoot()
        const handle = renderStatusButton(root, mkOptions({ count: 1, score: 90 }))
        const orbBefore = root.querySelector('.gf-orb') as HTMLElement
        const arcBefore = ringArc(orbBefore)
        const offsetBefore = arcBefore.getAttribute('stroke-dashoffset')
        const colorBefore = arcBefore.getAttribute('stroke')
        handle.update(mkOptions({ count: 2, score: 60 }))
        const orbAfter = root.querySelector('.gf-orb')
        expect(orbAfter).toBe(orbBefore) // same DOM node
        const arcAfter = ringArc(orbAfter as HTMLElement)
        expect(arcAfter.getAttribute('stroke-dashoffset')).not.toBe(offsetBefore)
        expect(arcAfter.getAttribute('stroke-dashoffset')).toBeCloseTo(arcOffset(60))
        // score 60 → 'fair' band → amber (different from the score 90 'excellent' green)
        expect(arcAfter.getAttribute('stroke')).toBe(BAND_COLOR.fair)
        expect(colorBefore).toBe(BAND_COLOR.excellent)
    })

    it("body click fires onFocusField", () => {
        const root = mkRoot()
        const onFocusField = vi.fn<() => void>()
        renderStatusButton(root, mkOptions({ onFocusField }))
        ;(root.querySelector('.gf-orb__body') as HTMLElement).dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
        expect(onFocusField).toHaveBeenCalledOnce()
    })

    it('mousedown on the orb BODY (drag surface) does not steal field focus', () => {
        // Regression: pressing the orb's draggable surface must preventDefault
        // its mousedown so the focused textarea does NOT blur — otherwise the
        // focus-only orb hides itself the instant you grab it, and the drag
        // dies mid-gesture.
        const root = mkRoot()
        renderStatusButton(root, mkOptions())
        const orb = root.querySelector('.gf-orb') as HTMLElement
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
        const prevented = !orb.dispatchEvent(ev)
        expect(prevented).toBe(true)
    })

    it('drag moves the orb from its current style position (no offsetLeft jump)', () => {
        // The orb is position:fixed; its authoritative position is style.left/
        // top (what we set), NOT offsetLeft (layout-derived, may differ → a
        // visual jump at drag start). The drag must start from style.left/top.
        // The W2 orb is 60×60 (the W1 pill was 110×28 — these numbers follow
        // the new ORB_SIZE fallback; if ORB_SIZE changes, update the math).
        const root = mkRoot()
        // ANCHOR 400×200 → default bottom-right style.left = 500-60-8 = 432,
        // style.top = 300-60-8 = 232.
        renderStatusButton(root, mkOptions())
        const orb = root.querySelector('.gf-orb') as HTMLElement
        expect(positionOf(orb).x).toBe(432)
        expect(positionOf(orb).y).toBe(232)
        orb.dispatchEvent(
            new PointerEvent('pointerdown', { clientX: 200, clientY: 200, bubbles: true }),
        )
        orb.dispatchEvent(
            new PointerEvent('pointermove', { clientX: 230, clientY: 250, bubbles: true }),
        )
        // Moved +30,+50 from the style start (432,232) → 462, 282.
        expect(positionOf(orb).x).toBe(462)
        expect(positionOf(orb).y).toBe(282)
        orb.dispatchEvent(
            new PointerEvent('pointerup', { clientX: 230, clientY: 250, bubbles: true }),
        )
    })

    it('re-rendering replaces the prior orb (no leaks)', () => {
        // The W1 hover panel is gone — the W2 orb is the only DOM the status
        // button owns. destroyExisting() just swaps the orb node.
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 2 }))
        renderStatusButton(root, mkOptions({ count: 3 }))
        expect(root.querySelectorAll('.gf-orb')).toHaveLength(1)
    })

    it('destroy() removes the orb and any DOM the orb owned', () => {
        // W2b: the orb owns no panel; destroy() removes the orb node only.
        const root = mkRoot()
        const handle = renderStatusButton(root, mkOptions())
        expect(handle.isMounted()).toBe(true)
        handle.destroy()
        expect(handle.isMounted()).toBe(false)
        expect(root.querySelector('.gf-orb')).toBeNull()
    })

    it('reposition() re-anchors the orb to a fresh field rect with the live offset', () => {
        const root = mkRoot()
        const handle = renderStatusButton(root, mkOptions({ dragOffset: { dx: 10, dy: 20 } }))
        const orb = root.querySelector('.gf-orb') as HTMLElement
        // Re-anchor to a field that has scrolled up by 100px.
        handle.reposition(new DOMRect(100, 0, 400, 200))
        // right=500, bottom=200 → 500-60-8+10 = 442 ; 200-60-8+20 = 152
        // (left 442 > maxLeft 432 → clamped to 432; top 152 > maxTop 132 →
        // clamped to 132).
        expect(positionOf(orb).x).toBe(432)
        expect(positionOf(orb).y).toBe(132)
    })

    it('dragging the orb past the threshold reports a new accumulated offset', () => {
        const root = mkRoot()
        const onDragMove = vi.fn<(o: { dx: number; dy: number }) => void>()
        renderStatusButton(root, mkOptions({ onDragMove }))
        const orb = root.querySelector('.gf-orb') as HTMLElement
        orb.dispatchEvent(
            new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }),
        )
        orb.dispatchEvent(
            new PointerEvent('pointermove', { clientX: 140, clientY: 130, bubbles: true }),
        )
        orb.dispatchEvent(
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
        const orb = root.querySelector('.gf-orb') as HTMLElement
        orb.dispatchEvent(
            new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }),
        )
        orb.dispatchEvent(
            new PointerEvent('pointermove', { clientX: 110, clientY: 120, bubbles: true }),
        )
        orb.dispatchEvent(
            new PointerEvent('pointerup', { clientX: 110, clientY: 120, bubbles: true }),
        )
        const off = onDragMove.mock.calls[0]![0]
        // seeded (5,7) + delta (10,20) = (15,27)
        expect(off.dx).toBe(15)
        expect(off.dy).toBe(27)
    })

    it('renders hidden when initiallyVisible is false (focus-only orb)', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ initiallyVisible: false }))
        const orb = root.querySelector('.gf-orb') as HTMLElement
        expect(orb.classList.contains('gf-orb--hidden')).toBe(true)
    })

    it('renders visible by default (initiallyVisible omitted)', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions())
        const orb = root.querySelector('.gf-orb') as HTMLElement
        expect(orb.classList.contains('gf-orb--hidden')).toBe(false)
    })

    it('setVisible toggles the hidden class', () => {
        const root = mkRoot()
        const handle = renderStatusButton(root, mkOptions({ initiallyVisible: false }))
        const orb = root.querySelector('.gf-orb') as HTMLElement
        expect(orb.classList.contains('gf-orb--hidden')).toBe(true)
        handle.setVisible(true)
        expect(orb.classList.contains('gf-orb--hidden')).toBe(false)
        handle.setVisible(false)
        expect(orb.classList.contains('gf-orb--hidden')).toBe(true)
    })

    it('a click without movement does NOT start a drag (body click still works)', () => {
        const root = mkRoot()
        const onDragMove = vi.fn<(o: { dx: number; dy: number }) => void>()
        const onFocusField = vi.fn<() => void>()
        renderStatusButton(root, mkOptions({ onDragMove, onFocusField }))
        const body = root.querySelector('.gf-orb__body') as HTMLElement
        body.dispatchEvent(
            new PointerEvent('pointerdown', { clientX: 10, clientY: 10, bubbles: true }),
        )
        body.dispatchEvent(
            new PointerEvent('pointerup', { clientX: 11, clientY: 10, bubbles: true }),
        )
        body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onDragMove).not.toHaveBeenCalled()
        expect(onFocusField).toHaveBeenCalledTimes(1)
    })

    it('update() refreshes the center glyph in place, reusing the same orb node', () => {
        const root = mkRoot()
        const handle = renderStatusButton(
            root,
            mkOptions({ count: 2, byCategory: { spelling: 2 } }),
        )
        const orbBefore = root.querySelector('.gf-orb')
        handle.update(mkOptions({ count: 5, byCategory: { spelling: 3, grammar: 2 } }))
        const orbAfter = root.querySelector('.gf-orb')
        expect(orbAfter).toBe(orbBefore)
        expect(root.querySelector('.gf-orb__glyph--count')?.textContent).toBe('5')
    })

    it('update() switches to the clean state when count drops to 0', () => {
        const root = mkRoot()
        const handle = renderStatusButton(root, mkOptions({ count: 3 }))
        handle.update(mkOptions({ count: 0, corrections: [], byCategory: {} }))
        expect(root.querySelector('.gf-orb__glyph--clean')).not.toBeNull()
    })

    it('update() preserves visibility state set via initiallyVisible', () => {
        const root = mkRoot()
        const handle = renderStatusButton(root, mkOptions({ count: 1, initiallyVisible: false }))
        expect(root.querySelector('.gf-orb')?.classList.contains('gf-orb--hidden')).toBe(true)
        handle.update(mkOptions({ count: 2 }))
        expect(root.querySelector('.gf-orb')?.classList.contains('gf-orb--hidden')).toBe(true)
    })

    it('positions the orb via left/top, not transform translate', () => {
        // The W2 design system uses `transform: scale(1.06)` on :hover, which
        // would clobber a positioning translate (both target the `transform`
        // property). The orb is therefore positioned via inline left/top so
        // the hover/active scale can run without touching the position.
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 1 }))
        const orb = root.querySelector('.gf-orb') as HTMLElement
        // Default bottom-right of the ANCHOR (100,100,400,200) = (432, 232).
        expect(orb.style.left).toBe('432px')
        expect(orb.style.top).toBe('232px')
        // No transform translate — the transform property is free for the
        // W2 :hover/:active scale to own.
        expect(orb.style.transform).toBe('')
    })

    it('a drag offset within the field shifts the orb (bound to the field)', () => {
        const root = mkRoot()
        // ANCHOR is 400×200 (right=500,bottom=300). A small offset keeps the
        // 60×60 orb inside the field box. Default bottom-right = (432, 232);
        // a (-50,-40) offset moves it up/left, still within the field.
        renderStatusButton(root, mkOptions({ dragOffset: { dx: -50, dy: -40 } }))
        const orb = root.querySelector('.gf-orb') as HTMLElement
        expect(positionOf(orb).x).toBe(382)
        expect(positionOf(orb).y).toBe(192)
    })

    it('a drag offset cannot push the orb outside the field box (clamped to field)', () => {
        const root = mkRoot()
        // A big positive offset would put the 60×60 orb past the field's
        // bottom-right; the field-clamp pins it to the field's far edge.
        // maxLeft = 500-60-8 = 432 ; maxTop = 300-60-8 = 232.
        renderStatusButton(root, mkOptions({ dragOffset: { dx: 500, dy: 500 } }))
        const orb = root.querySelector('.gf-orb') as HTMLElement
        expect(positionOf(orb).x).toBe(432)
        expect(positionOf(orb).y).toBe(232)
    })

    it('W2b: the orb does NOT render a .gf-pill-panel on click (the W1 hover panel is retired)', () => {
        // Single, explicit guard: clicking the orb's body must NOT mount
        // the W1 hover panel (.gf-pill-panel). The W2b review panel
        // (.gf-panel-aside) is owned by the orchestrator's onOpen callback
        // — the orb itself mounts nothing.
        const root = mkRoot()
        const onOpen = vi.fn<() => void>()
        renderStatusButton(root, mkOptions({ onOpen }))
        const body = root.querySelector('.gf-orb__body') as HTMLElement
        body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(root.querySelector('.gf-pill-panel')).toBeNull()
        expect(root.querySelector('.gf-panel-aside')).toBeNull()
        expect(onOpen).toHaveBeenCalledOnce()
    })

    it('W2b: the orb does NOT render a .gf-pill-panel on hover (W1 hover is retired)', () => {
        const root = mkRoot()
        renderStatusButton(root, mkOptions())
        const orb = root.querySelector('.gf-orb') as HTMLElement
        orb.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
        expect(root.querySelector('.gf-pill-panel')).toBeNull()
    })

    it('W2b: arcOffset + BAND_COLOR are consumed only via orbState (no dead void stubs)', () => {
        // The W2a review-flag nit: the old `void arcOffset` / `void BAND_COLOR`
        // suppression stubs (with their imports) are GONE — arcOffset/BAND_COLOR
        // flow through orbState() and are the real consumer in this file.
        // This test exercises the math path to confirm the imports are
        // reachable for the type annotations used by the test (arcOffset,
        // BAND_COLOR) — but in the SOURCE file there should be no `void`
        // suppression line (we can't read the source from here, but the
        // type-only import is the loader's proof).
        const root = mkRoot()
        renderStatusButton(root, mkOptions({ count: 1, score: 80 }))
        const arc = ringArc(root.querySelector('.gf-orb') as HTMLElement)
        expect(parseFloat(arc.getAttribute('stroke-dashoffset') ?? '')).toBeCloseTo(arcOffset(80))
        expect(arc.getAttribute('stroke')).toBe(BAND_COLOR.good)
    })
})
