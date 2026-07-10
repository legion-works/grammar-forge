// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// The per-field score orb (formerly the status pill). Three responsibilities:
//   1. Render the score ring (track + band-colored arc) + the inner state
//      glyph (count number / ✓ clean / power (paused) / ✨ AI pip while the
//      LLM is still refining).
//   2. Be the click target that opens the per-field review panel — the
//      W2b redesign fires `onOpen`, and the caller (orchestrator) wires
//      that callback to `showPanel` from `@/overlay/panel`. The W1 hover
//      panel is RETIRED in W2b (the new review panel replaces it).
//   3. Drag the orb to a new spot inside its field (session-persisted offset
//      so it re-anchors as the field scrolls/resizes).
// Anchored to the bottom-right corner of the field; positioned from its
// measured size after mount so a wide label never overflows the field edge.
import type { Band, Category, Phase } from '@/api/types'
import { orbState } from '@/lib/view-model'

const ORB_SIZE = 44
const PILL_WIDTH_FALLBACK = ORB_SIZE
const PILL_HEIGHT_FALLBACK = ORB_SIZE
const VIEWPORT_GUTTER = 8
const DRAG_THRESHOLD_PX = 4

/** One correction shown in the hover panel (display-only diff + category).
 *  Kept on the public surface for back-compat with the Vencord orchestrator's
 *  `buildPillOptions` — the W2b review panel reads the FULL `RenderableItem`
 *  via its own options, not this condensed shape. W3 will retire this once
 *  the Vencord orchestrator stops passing hover-panel-shaped data. */
export interface PillCorrection {
    category: Category
    diffOriginal: string
    diffCorrected: string
    diffIsDeletion: boolean
}

export interface StatusButtonOptions {
    /** Number of issues; 0 = clean state. The orb's center glyph switches to
     *  "✓" when this is 0 (and to a pulsing AI pip when `phase === 'fast'`). */
    count: number
    /** Per-category breakdown. KEPT in the type for back-compat with the
     *  Vencord orchestrator's `buildPillOptions` (which always passes
     *  `tallyByCategory(st.items)`); the W2 orb no longer renders a
     *  breakdown bar — the W2b review panel owns per-category counts. */
    byCategory?: Partial<Record<Category, number>>
    /** Viewport rect of the field the orb is anchored to. */
    anchorRect: DOMRect
    /** Collapsed power-only state (checking disabled on this site). */
    disabled: boolean
    /** Corrections for the hover panel. Unused by the W2b orb — the review
     *  panel reads the full items list from its own options. Kept for
     *  back-compat with the Vencord orchestrator. */
    corrections: PillCorrection[]
    /** Click the orb body — focus the field. */
    onFocusField: () => void
    /** Click the power button — toggle site disable. Unused by the W2b
     *  orb; the review panel's footer "Disable on this site" owns the
     *  toggle. Kept for back-compat. */
    onTogglePower: () => void
    /** "Recheck" — unused by the W2b orb; the review panel's head
     *  recheck button owns the action. Kept for back-compat. */
    onRecheck: () => void
    /** "Apply all" in the W1 hover panel. Unused by the W2b orb. */
    onApplyAll: () => void
    /** "Apply one" in the W1 hover panel. Unused by the W2b orb. */
    onApplyOne: (index: number) => void
    /** "Undo last apply" in the W1 hover panel. Unused by the W2b orb. */
    onUndo: () => void
    /** "Rephrase" in the W1 hover panel. Unused by the W2b orb. */
    onRephrase?: () => void
    /** "Undo" button enable state. Unused by the W2b orb. */
    undoAvailable: boolean
    /** Drag OFFSET from the field's default bottom-right anchor (dx,dy). When
     *  set, the orb is placed at (anchor + offset), clamped — so a dragged
     *  position is RELATIVE to the field and re-anchors as the field moves
     *  (scroll/reflow). Persisted across re-renders and the enabled↔disabled
     *  orb swap. */
    dragOffset?: { dx: number; dy: number }
    /** Called when the user finishes dragging; reports the new accumulated
     *  offset from the field's default anchor. */
    onDragMove?: (offset: { dx: number; dy: number }) => void
    /** Initial visibility (default true). The active per-field orb is
     *  FOCUS-ONLY: the orchestrator passes `false` when the field isn't focused
     *  at render time, then toggles via `handle.setVisible` on focus/blur. The
     *  disabled (site-paused) orb omits this (always visible). */
    initiallyVisible?: boolean
    /** 0-100 writing score. Drives the ring's `stroke-dashoffset` and the
     *  band-colored `stroke` of the progress arc. Undefined = not yet
     *  computed (ring renders full + green until the first check resolves). */
    score?: number
    /** Streaming phase for the fast→slow pipeline. 'fast' swaps the count
     *  badge for a pulsing AI pip on the orb. */
    phase?: Phase
    /** Pre-computed band label — short-circuits the score→band lookup in the
     *  orb's render path. Optional: derive from `score` when omitted. */
    band?: Band
    /** Fires on orb click. The W2b review-panel entry point — the
     *  orchestrator wires this to `showPanel` from `@/overlay/panel`. */
    onOpen?: () => void
}

export interface StatusButtonHandle {
    destroy: () => void
    isMounted: () => boolean
    /** Re-anchor the orb to a fresh field rect, re-applying the live drag
     *  offset. Called by the shared scroll/resize loop so the orb tracks its
     *  field instead of staying pinned while the field scrolls away. */
    reposition: (anchorRect: DOMRect) => void
    /** Show/hide the orb without destroying it. The orb is FOCUS-ONLY: the
     *  orchestrator hides it on field blur and shows it on focus (a hidden
     *  orb is `display:none` so it neither paints nor intercepts pointer
     *  events, but its drag state survives). */
    setVisible: (visible: boolean) => void
    /** Refresh the orb's ring + center glyph IN PLACE (no teardown) when a
     *  new check resolves. Preserves the orb element, its drag offset +
     *  live drag, and the visibility (setVisible) state. The W2b review
     *  panel is owned by the orchestrator; this method does not touch it
     *  (the next onOpen() rebuilds it with fresh data). */
    update: (options: StatusButtonOptions) => void
}

// NOTE: the xmlns attribute is REQUIRED. The power SVG is inlined via
// innerHTML in buildCenterHTML; the browser's HTML parser namespaces the
// <svg> automatically (DOMParser('image/svg+xml') would NOT — that's why
// the W1 panel had a separate `svgFromConstant` helper for its action
// icons, which the W2b review panel no longer needs).
const POWER_SVG =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" ` +
    `fill="none" stroke="currentColor" ` +
    `stroke-width="2.4" stroke-linecap="round" aria-hidden="true">` +
    `<path d="M12 4 L12 12" /><path d="M7.5 6.5 A7 7 0 1 0 16.5 6.5" /></svg>`

// Reused by the score-ring + track SVG creation below.
const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Render the per-field score orb in the supplied shadow root. Replaces any
 * prior orb. The returned handle's destroy() removes the orb and clears
 * its listeners.
 */
export function renderStatusButton(
    root: ShadowRoot,
    options: StatusButtonOptions,
): StatusButtonHandle {
    destroyExisting(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    // Mutable current options: update() swaps this in place so the ring/
    // center glyph + the click closures all read fresh data without
    // recreating the orb (and its drag state / listeners / visibility).
    let current = options

    const orb = doc.createElement('div')
    orb.className = 'gf-orb'
    if (current.disabled) orb.classList.add('gf-orb--disabled')

    // The score-ring SVG. A sibling of the body (NOT inside it) so the SVG
    // is a pure visual layer — pointer events flow straight through to the
    // body button underneath. r=24.5 / dasharray=153.9 / viewBox=58 — these
    // match the reference DC (lines 191-192) and the view-model arcOffset
    // helper. Don't change any of these numbers without updating both.
    const ringSvg = doc.createElementNS(SVG_NS, 'svg')
    ringSvg.setAttribute('class', 'gf-ring')
    ringSvg.setAttribute('viewBox', '0 0 58 58')
    ringSvg.setAttribute('width', String(ORB_SIZE))
    ringSvg.setAttribute('height', String(ORB_SIZE))
    ringSvg.setAttribute('aria-hidden', 'true')
    const track = doc.createElementNS(SVG_NS, 'circle')
    track.setAttribute('class', 'gf-ring__track')
    track.setAttribute('cx', '29')
    track.setAttribute('cy', '29')
    track.setAttribute('r', '24.5')
    track.setAttribute('fill', 'none')
    track.setAttribute('stroke-width', '3.2')
    ringSvg.appendChild(track)
    const arc = doc.createElementNS(SVG_NS, 'circle')
    arc.setAttribute('class', 'gf-ring__arc')
    arc.setAttribute('cx', '29')
    arc.setAttribute('cy', '29')
    arc.setAttribute('r', '24.5')
    arc.setAttribute('fill', 'none')
    arc.setAttribute('stroke-width', '3.2')
    arc.setAttribute('stroke-linecap', 'round')
    arc.setAttribute('stroke-dasharray', '153.9')
    arc.setAttribute('transform', 'rotate(-90 29 29)')
    ringSvg.appendChild(arc)
    orb.appendChild(ringSvg)

    // Body (center glyph — count / ✓ / power / ✨ pip). Always present.
    // Click focuses the field AND fires onOpen (the W2b review-panel entry
    // point). The orchestrator wires onOpen to `showPanel` from
    // `@/overlay/panel`. The body is a real <button> so it's
    // keyboard-activatable and screen-readers announce it as the trigger.
    const body = doc.createElement('button')
    body.type = 'button'
    body.className = 'gf-orb__body'
    bindButton(body, () => {
        current.onFocusField()
        current.onOpen?.()
    })
    orb.appendChild(body)

    // Refill the body + arc attributes from `current`. Called on mount and
    // on every update(). The state derivation goes through the view-model
    // helper so the orb never recomputes score/band/arc math itself.
    const renderBody = (): void => {
        const s = orbState({
            score: current.score,
            band: current.band,
            openCount: current.count,
            phase: current.phase ?? 'done',
            disabled: current.disabled,
        })
        body.setAttribute(
            'aria-label',
            current.count === 0 ? 'No grammar issues' : `${current.count} grammar issues`,
        )
        body.innerHTML = buildCenterHTML(s)
        // Ring color + dashoffset — arcOffset(0) = 153.9 (no ring), arcOffset(100) = 0 (full).
        arc.setAttribute('stroke', s.ringColor)
        arc.setAttribute('stroke-dashoffset', s.ringOffset.toFixed(2))
    }
    renderBody()

    root.appendChild(orb)
    // Focus-only visibility: a hidden orb is display:none (no paint, no
    // pointer events) but keeps its drag state. Default visible.
    if (current.initiallyVisible === false) orb.classList.add('gf-orb--hidden')
    // Live drag offset from the field's default bottom-right anchor. Seeded
    // from the persisted session offset; drag-end accumulates into it; the
    // shared scroll/resize loop re-anchors via `reposition` using this value.
    let currentOffset = current.dragOffset ?? { dx: 0, dy: 0 }
    positionPill(orb, current.anchorRect, view, currentOffset)

    // Pointer-drag (session). A move past DRAG_THRESHOLD_PX starts a drag; a
    // plain click (no move) still reaches the inner buttons. On drop, report the
    // new offset from the field's default bottom-right anchor.
    let dragStart: { x: number; y: number; left: number; top: number } | null = null
    let dragged = false
    const onPointerDown = (e: PointerEvent): void => {
        if (e.button !== 0) return
        // Start from the AUTHORITATIVE left/top (what positionPill set), NOT
        // orb.offsetLeft/Top: offsetLeft is layout-derived and can differ from
        // the inline left we just wrote — reading it caused a visual jump at
        // drag start. (We previously read transform translate, but the W2
        // design uses transform: scale(1.06) on :hover which clobbers any
        // positioning translate — see positionAbsolute.)
        const left = parseFloat(orb.style.left) || 0
        const top = parseFloat(orb.style.top) || 0
        dragStart = { x: e.clientX, y: e.clientY, left, top }
        dragged = false
    }
    const onPointerMove = (e: PointerEvent): void => {
        if (!dragStart) return
        const ddx = e.clientX - dragStart.x
        const ddy = e.clientY - dragStart.y
        if (!dragged && Math.hypot(ddx, ddy) < DRAG_THRESHOLD_PX) return
        if (!dragged) {
            // Capture the pointer only once a REAL drag begins. Capturing on
            // pointerdown retargets the subsequent `click` to the orb, which
            // swallowed clicks on the inner power/recheck buttons. (setPointerCapture
            // is missing from the jsdom test build — guard it.)
            if (typeof orb.setPointerCapture === 'function') orb.setPointerCapture(e.pointerId)
        }
        dragged = true
        orb.classList.add('gf-orb--dragging')
        // Position via left/top (the W2 :hover scale uses transform, so we
        // must keep positioning off the transform property). The browser
        // does not reflow on inline style writes outside of layout reads,
        // and the scroll/resize loop never reads offsetLeft/Top between
        // writes — the inline update is composited.
        orb.style.left = `${dragStart.left + ddx}px`
        orb.style.top = `${dragStart.top + ddy}px`
    }
    const onPointerUp = (e: PointerEvent): void => {
        if (!dragStart) return
        try {
            if (typeof orb.releasePointerCapture === 'function')
                orb.releasePointerCapture(e.pointerId)
        } catch {
            /* not captured */
        }
        if (dragged) {
            orb.classList.remove('gf-orb--dragging')
            const ddx = e.clientX - dragStart.x
            const ddy = e.clientY - dragStart.y
            // Accumulate this drag's delta into the field-relative offset so the
            // orb keeps tracking its field (the shared scroll/resize loop calls
            // reposition with this offset) and the spot persists across
            // re-renders and the enabled↔disabled orb swap.
            currentOffset = { dx: currentOffset.dx + ddx, dy: currentOffset.dy + ddy }
            current.onDragMove?.(currentOffset)
        }
        dragStart = null
    }
    const onClickCapture = (e: MouseEvent): void => {
        if (dragged) {
            e.preventDefault()
            e.stopPropagation()
            dragged = false
        }
    }
    // Pressing the orb (anywhere — the draggable surface, the gaps, the
    // badge) must NOT blur the focused field. Without this, mousedown's default
    // action moves focus off the textarea → the orchestrator's blur handler
    // hides the focus-only orb mid-press, and the in-flight drag dies on a
    // now-`display:none` element. The inner buttons already preventDefault
    // their own mousedown (bindButton); this covers everything else. We do NOT
    // stopPropagation (nothing above needs the event) and do NOT preventDefault
    // pointer/click events, so dragging + button clicks still work.
    const onPillMouseDown = (e: MouseEvent): void => {
        e.preventDefault()
    }
    orb.addEventListener('mousedown', onPillMouseDown)
    orb.addEventListener('pointerdown', onPointerDown)
    orb.addEventListener('pointermove', onPointerMove)
    orb.addEventListener('pointerup', onPointerUp)
    orb.addEventListener('click', onClickCapture, { capture: true })

    return {
        destroy: () => {
            orb.remove()
        },
        isMounted: () => orb.isConnected,
        reposition: (anchorRect: DOMRect) => positionPill(orb, anchorRect, view, currentOffset),
        setVisible: (visible: boolean) => {
            orb.classList.toggle('gf-orb--hidden', !visible)
        },
        update: (next: StatusButtonOptions) => {
            current = next
            orb.classList.toggle('gf-orb--disabled', current.disabled)
            renderBody()
        },
    }
}

function bindButton(el: HTMLElement, onClick: () => void): void {
    // mousedown preventDefault so the field doesn't lose focus/caret.
    el.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
    })
    el.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
    })
}

function destroyExisting(root: ShadowRoot): void {
    // W2b: the W1 hover panel (.gf-pill-panel) is RETIRED. The W2b review
    // panel (.gf-panel-aside) is owned by `showPanel` in @/overlay/panel
    // and is replaced by the orchestrator; this teardown only needs to
    // swap the orb node.
    root.querySelectorAll('.gf-orb').forEach((el) => el.remove())
}

function positionPill(
    pill: HTMLElement,
    anchor: DOMRect,
    view: Window,
    offset: { dx: number; dy: number } = { dx: 0, dy: 0 },
): void {
    // Placement audit (SCORE ORB): when the field this orb belongs to has
    // scrolled entirely out of the viewport, HIDE the orb instead of letting
    // the viewport clamp below pin it to the nearest edge — an orb floating
    // at (say) the top-left of the screen while its field is scrolled
    // hundreds of pixels away reads as a stray, detached widget, not a
    // status indicator for anything the user can see. `gf-orb--offscreen`
    // is a SEPARATE class from the focus-driven `gf-orb--hidden` (see
    // styles.ts) so the two independent hide-reasons don't clobber each
    // other. Toggled on every reposition() call (the shared scroll/resize
    // loop), so the orb reappears the instant any part of the field
    // re-enters the viewport.
    const offscreen = isRectOffscreen(anchor, view)
    pill.classList.toggle('gf-orb--offscreen', offscreen)
    if (offscreen) return
    const width = pill.offsetWidth || PILL_WIDTH_FALLBACK
    const height = pill.offsetHeight || PILL_HEIGHT_FALLBACK
    // Default anchor: bottom-right of the field, shifted by the live drag
    // offset so a dragged orb re-anchors to the field as it moves.
    const left = anchor.right - width - VIEWPORT_GUTTER + offset.dx
    const top = anchor.bottom - height - VIEWPORT_GUTTER + offset.dy
    // The orb is BOUND to its field: clamp so it can't escape the field's
    // box (a drag can move it within the field, but never outside it), then
    // clamp to the viewport as a final safety. For a field smaller than the
    // orb the field-clamp pins the orb to the field's bottom-right corner.
    const pos = clampToRect({ left, top }, width, height, anchor)
    positionAbsolute(pill, pos, view)
}

/** True when `rect` has NO intersection with the viewport at all (fully
 *  scrolled above/below/left/right of it) — as opposed to merely partially
 *  clipped, which still leaves the orb meaningfully anchored. */
function isRectOffscreen(rect: DOMRect, view: Window): boolean {
    const vw = view.innerWidth
    const vh = view.innerHeight
    return rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw
}

/**
 * Clamp a top-left position so a `width`×`height` box stays inside `rect`
 * (inset by VIEWPORT_GUTTER). When the box is larger than the rect on an axis,
 * the box is pinned to the rect's far (right/bottom) edge — so the orb stays
 * attached to a small field's bottom-right corner rather than centering or
 * overflowing the near edge.
 */
function clampToRect(
    pos: { left: number; top: number },
    width: number,
    height: number,
    rect: DOMRect,
): { left: number; top: number } {
    let { left, top } = pos
    const maxLeft = rect.right - width - VIEWPORT_GUTTER
    const maxTop = rect.bottom - height - VIEWPORT_GUTTER
    const minLeft = rect.left + VIEWPORT_GUTTER
    const minTop = rect.top + VIEWPORT_GUTTER
    // Right/bottom edge first, then left/top — so if the field is too small
    // (min > max) the far-edge pin wins (orb clings to bottom-right corner).
    if (left > maxLeft) left = maxLeft
    if (left < minLeft) left = minLeft
    if (top > maxTop) top = maxTop
    if (top < minTop) top = minTop
    return { left, top }
}

/** Place the orb at an absolute viewport position, clamped into the viewport. */
function positionAbsolute(
    pill: HTMLElement,
    pos: { left: number; top: number },
    view: Window,
): void {
    const vw = view.innerWidth
    const vh = view.innerHeight
    const width = pill.offsetWidth || PILL_WIDTH_FALLBACK
    const height = pill.offsetHeight || PILL_HEIGHT_FALLBACK
    let { left, top } = pos
    if (left > vw - width - VIEWPORT_GUTTER) left = vw - width - VIEWPORT_GUTTER
    if (top > vh - height - VIEWPORT_GUTTER) top = vh - height - VIEWPORT_GUTTER
    if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER
    if (top < VIEWPORT_GUTTER) top = VIEWPORT_GUTTER
    // Position via left/top (NOT transform). The W2 design system uses
    // `transform: scale(1.06)` for the orb's :hover/:active lift — that
    // shares the `transform` property with our positioning translate, so
    // either rule (inline or CSS) would clobber the other. left/top is
    // independent of transform, so the hover/active scale now operates on
    // the orb's own center without touching its viewport position.
    pill.style.left = `${left}px`
    pill.style.top = `${top}px`
    pill.style.transform = ''
}

/** Inner glyph for the orb's center. The state selection lives in
 *  `orbState()` (view-model); this just turns the result into markup. */
function buildCenterHTML(s: ReturnType<typeof orbState>): string {
    if (s.center === 'power') {
        return `<span class="gf-orb__glyph gf-orb__glyph--power" aria-hidden="true">${POWER_SVG}</span>`
    }
    if (s.center === 'pip') {
        // The `gf-pip` class is the design-system pulsing animation
        // (keyframes in styles.ts). The orchestrator-driven phase transition
        // fast → done swaps this span out for the count number.
        return `<span class="gf-orb__glyph gf-pip" aria-hidden="true">✨</span>`
    }
    if (s.center === 'clean') {
        return `<span class="gf-orb__glyph gf-orb__glyph--clean" aria-hidden="true">✓</span>`
    }
    return (
        `<span class="gf-orb__glyph gf-orb__glyph--count" ` +
        `aria-live="polite" aria-atomic="true">${s.count}</span>`
    )
}
