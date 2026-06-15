// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// The per-field score orb (formerly the status pill). Four responsibilities:
//   1. Render the score ring (track + band-colored arc) + the inner state
//      glyph (count number / ✓ clean / power (paused) / ✨ AI pip while the
//      LLM is still refining).
//   2. Be the click target that opens the per-field review panel — for the
//      W2 redesign this fires `onOpen`; the existing hover panel stays as the
//      legacy path until W2b replaces it with the full review panel.
//   3. Drag the orb to a new spot inside its field (session-persisted offset
//      so it re-anchors as the field scrolls/resizes).
//   4. Show a streaming "Fast results in · AI refining…" banner inside the
//      panel while `phase === 'fast'`, so the streaming state has a panel-
//      level signal in addition to the AI pip on the orb itself.
// Anchored to the bottom-right corner of the field; positioned from its
// measured size after mount so a wide label never overflows the field edge.
import { diffInnerHTML } from '@/overlay/diff-view'
import type { Band, Category, Phase } from '@/api/types'
import { arcOffset, BAND_COLOR, orbState } from '@/lib/view-model'

const ORB_SIZE = 60
const PILL_WIDTH_FALLBACK = ORB_SIZE
const PILL_HEIGHT_FALLBACK = ORB_SIZE
const VIEWPORT_GUTTER = 8
const PANEL_HIDE_GRACE_MS = 150
const DRAG_THRESHOLD_PX = 4

/** One correction shown in the hover panel (display-only diff + category). */
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
     *  breakdown bar — the W2b review panel will own per-category counts. */
    byCategory?: Partial<Record<Category, number>>
    /** Viewport rect of the field the orb is anchored to. */
    anchorRect: DOMRect
    /** Collapsed power-only state (checking disabled on this site). */
    disabled: boolean
    /** Corrections for the hover panel (ignored when disabled / count 0). */
    corrections: PillCorrection[]
    /** Click the orb body — focus the field. */
    onFocusField: () => void
    /** Click the power button — toggle site disable. */
    onTogglePower: () => void
    /** Click the recheck button — force a fresh check of the field now. */
    onRecheck: () => void
    /** "Apply all" in the hover panel. */
    onApplyAll: () => void
    /** Click a single correction row in the hover panel. */
    onApplyOne: (index: number) => void
    /** "Undo last apply" in the panel action row. */
    onUndo: () => void
    /** "Rephrase" in the panel action row (selection, else whole field).
     *  Optional: omit when the host has no rephrase action (the button is
     *  then hidden in the panel). Reads freshly on every panel build, so
     *  update() can add/drop the callback between checks. */
    onRephrase?: () => void
    /** Enables the panel's Undo button (the field has an undoable apply). */
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
     *  badge for a pulsing AI pip on the orb and adds a streaming banner to
     *  the panel; 'done' is the default and shows the count. */
    phase?: Phase
    /** Pre-computed band label — short-circuits the score→band lookup in the
     *  orb's render path. Optional: derive from `score` when omitted. */
    band?: Band
    /** Fires on orb click (alongside the existing showPanel() hover-panel
     *  path). The W2b review panel listens to this; for now it's a stub the
     *  orchestrator can leave undefined. */
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
     *  events, but its hover panel / drag state survive). */
    setVisible: (visible: boolean) => void
    /** Programmatic open of the same hover panel (same code path, same anchor).
     *  No-op when the panel is already open, when the orb is hidden via
     *  setVisible(false), or after destroy(). */
    openPanel: () => void
    /** Programmatic close. Idempotent: safe to call when the panel is closed
     *  (and after destroy()). */
    closePanel: () => void
    /** Refresh the orb's ring + center glyph + hover-panel corrections IN
     *  PLACE (no teardown) when a new check resolves. Preserves the orb
     *  element, its drag offset + live drag, the hover-panel lifecycle, and
     *  the visibility (setVisible) state. A panel open at update time is
     *  closed (it reopens with fresh data on the next hover). */
    update: (options: StatusButtonOptions) => void
}

// NOTE: the xmlns attribute is REQUIRED. svgFromConstant parses these with
// DOMParser('image/svg+xml') — a strict XML parser that does NOT auto-
// namespace <svg> the way the HTML parser (innerHTML) did. Without xmlns the
// elements land in no namespace and the browser renders nothing.
const POWER_SVG =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" ` +
    `fill="none" stroke="currentColor" ` +
    `stroke-width="2.4" stroke-linecap="round" aria-hidden="true">` +
    `<path d="M12 4 L12 12" /><path d="M7.5 6.5 A7 7 0 1 0 16.5 6.5" /></svg>`

const REFRESH_SVG =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" ` +
    `fill="none" stroke="currentColor" ` +
    `stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M20 11 A8 8 0 1 0 18.4 16"/><path d="M20 4 L20 11 L13 11"/></svg>`

const UNDO_SVG =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" ` +
    `fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M9 14 L4 9 L9 4"/><path d="M4 9 H14 A6 6 0 1 1 14 21 H10"/></svg>`

const REPHRASE_SVG =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" ` +
    `fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M4 7 H20 M4 12 H14 M4 17 H10"/><path d="M17 14 L21 18 L17 22"/></svg>`

// Parse a TRUSTED, hardcoded SVG constant into a real element. DOMParser with
// image/svg+xml never executes scripts, and going through it (instead of
// innerHTML on the live element) keeps the "no innerHTML" rule greppable and
// makes any future interpolation of these constants an obvious code smell.
const SVG_NS = 'http://www.w3.org/2000/svg'

function svgFromConstant(doc: Document, svgText: string): SVGElement {
    const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml')
    const el = parsed.documentElement
    // Guard the namespace: a constant missing xmlns parses "successfully"
    // into no-namespace elements that silently render as NOTHING (live bug:
    // invisible orb icons). Fail loudly at the source instead.
    if (el.namespaceURI !== SVG_NS) {
        throw new Error('svgFromConstant: constant must carry xmlns="http://www.w3.org/2000/svg"')
    }
    return doc.importNode(el, true) as unknown as SVGElement
}

/**
 * Render the per-field score orb (+ its hover panel) in the supplied shadow
 * root. Replaces any prior orb. The returned handle's destroy() removes the
 * orb AND the hover panel AND clears the hide timer + listeners.
 */
export function renderStatusButton(
    root: ShadowRoot,
    options: StatusButtonOptions,
): StatusButtonHandle {
    destroyExisting(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    // Mutable current options: update() swaps this in place so the ring/
    // center glyph + the panel/click closures all read fresh data without
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
    // Click focuses the field AND opens the panel AND fires onOpen (the W2b
    // review-panel entry point). The body is a real <button> so it's
    // keyboard-activatable and screen-readers announce it as the trigger.
    const body = doc.createElement('button')
    body.type = 'button'
    body.className = 'gf-orb__body'
    bindButton(body, () => {
        current.onFocusField()
        clearHide()
        showPanel()
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
    // pointer events) but keeps its drag/hover state. Default visible.
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
        // Start from the AUTHORITATIVE transform translate (what positionPill
        // set), NOT orb.offsetLeft/Top: the orb is position:fixed at 0,0 with
        // a transform offset, so offsetLeft is layout-derived and can differ
        // from our translate — reading it caused a visual jump at drag start.
        const t = readTranslate(orb)
        dragStart = { x: e.clientX, y: e.clientY, left: t.x, top: t.y }
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
        // Position via transform (composited, no reflow); left/top stay 0.
        orb.style.transform = `translate(${dragStart.left + ddx}px, ${dragStart.top + ddy}px)`
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

    // Hover panel (only when there are corrections to show).
    let panel: HTMLElement | null = null
    let hideTimer: number | null = null
    const clearHide = (): void => {
        if (hideTimer !== null) {
            view.clearTimeout(hideTimer)
            hideTimer = null
        }
    }
    const hidePanel = (): void => {
        clearHide()
        if (panel?.isConnected) panel.remove()
        panel = null
    }
    const scheduleHide = (): void => {
        clearHide()
        hideTimer = view.setTimeout(hidePanel, PANEL_HIDE_GRACE_MS)
    }
    const showPanel = (): void => {
        if (panel) return
        // Programmatic openPanel after destroy() / while the orb is hidden
        // (setVisible(false)) must be a no-op. The orb node carries the
        // gf-orb--hidden class; display:none already blocks hover from
        // reaching it, but openPanel can be called directly.
        if (!orb.isConnected) return
        if (orb.classList.contains('gf-orb--hidden')) return
        panel = buildPanel(doc, current)
        root.appendChild(panel)
        positionPanel(panel, orb.getBoundingClientRect(), view)
        panel.addEventListener('mouseenter', clearHide)
        panel.addEventListener('mouseleave', scheduleHide)
        panel.addEventListener('mousedown', (e) => e.stopPropagation())
        panel.addEventListener('click', (event) => {
            const target = event.target as HTMLElement | null
            const btn = target?.closest<HTMLElement>('[data-action]')
            if (!btn) return
            // Disabled buttons (Undo when undoAvailable is false) never fire
            // click in browsers/jsdom — guard defensively in case a browser
            // dispatches click anyway.
            if (btn instanceof HTMLButtonElement && btn.disabled) return
            event.preventDefault()
            event.stopPropagation()
            if (btn.dataset.action === 'apply-all') {
                hidePanel()
                current.onApplyAll()
                return
            }
            if (btn.dataset.action === 'apply-one') {
                const i = Number.parseInt(btn.dataset.index ?? '', 10)
                if (Number.isInteger(i)) {
                    hidePanel()
                    current.onApplyOne(i)
                }
                return
            }
            if (btn.dataset.action === 'undo') {
                hidePanel()
                current.onUndo()
                return
            }
            if (btn.dataset.action === 'recheck') {
                hidePanel()
                current.onRecheck()
                return
            }
            if (btn.dataset.action === 'rephrase') {
                hidePanel()
                // Defensive: the button is only rendered when onRephrase is
                // supplied, but guard against stale panels whose options
                // changed between build and click.
                current.onRephrase?.()
                return
            }
            if (btn.dataset.action === 'power') {
                hidePanel()
                current.onTogglePower()
                return
            }
        })
    }

    orb.addEventListener('mouseenter', () => {
        clearHide()
        showPanel()
    })
    orb.addEventListener('mouseleave', scheduleHide)

    return {
        destroy: () => {
            hidePanel()
            orb.remove()
        },
        isMounted: () => orb.isConnected,
        reposition: (anchorRect: DOMRect) => positionPill(orb, anchorRect, view, currentOffset),
        setVisible: (visible: boolean) => {
            orb.classList.toggle('gf-orb--hidden', !visible)
        },
        // openPanel / closePanel are the SAME code path as the hover panel
        // (showPanel / hidePanel). External callers (e.g. the Vencord client)
        // can drive the panel without dispatching synthetic mouse events;
        // showPanel's own guards (already-open, isConnected, hidden) keep
        // both paths identical.
        openPanel: showPanel,
        closePanel: hidePanel,
        update: (next: StatusButtonOptions) => {
            current = next
            orb.classList.toggle('gf-orb--disabled', current.disabled)
            renderBody()
            // A panel open at update time is closed; it reopens on the next
            // hover with fresh corrections (update happens per-check, not
            // per-hover, so this is invisible in practice).
            hidePanel()
        },
    }
}

/** Read the orb's current transform translate offset (x,y in px). Returns
 *  {0,0} when no translate is set (jsdom / pre-position). */
function readTranslate(el: HTMLElement): { x: number; y: number } {
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform)
    return m ? { x: parseFloat(m[1]!), y: parseFloat(m[2]!) } : { x: 0, y: 0 }
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
    root.querySelectorAll('.gf-orb, .gf-pill-panel').forEach((el) => el.remove())
}

function positionPill(
    pill: HTMLElement,
    anchor: DOMRect,
    view: Window,
    offset: { dx: number; dy: number } = { dx: 0, dy: 0 },
): void {
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
    // Position via transform (composited, no reflow). The orb stays
    // position:fixed at 0,0 and the translate carries the offset; the scroll/
    // resize loop rewriting the transform never forces a synchronous layout.
    pill.style.left = '0'
    pill.style.top = '0'
    pill.style.transform = `translate(${left}px, ${top}px)`
}

function positionPanel(panel: HTMLElement, pillRect: DOMRect, view: Window): void {
    const vw = view.innerWidth
    const width = panel.offsetWidth || 280
    const height = panel.offsetHeight || 160
    // Right-align the panel to the orb, sitting just ABOVE it (no gap, so
    // the pointer can travel orb -> panel without leaving the hover group).
    let left = pillRect.right - width
    if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER
    if (left + width > vw - VIEWPORT_GUTTER) left = vw - width - VIEWPORT_GUTTER
    let top = pillRect.top - height
    if (top < VIEWPORT_GUTTER) top = pillRect.bottom // flip below if no room above
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
}

function buildPanel(doc: Document, options: StatusButtonOptions): HTMLElement {
    const panel = doc.createElement('div')
    panel.className = 'gf-pill-panel'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'Corrections')
    // Streaming banner: visible ONLY while the LLM is still refining. The
    // orb's center shows the AI pip at the same time, but the panel needs
    // its own panel-level signal (the pip is tiny and off to the side).
    if (options.phase === 'fast') {
        const banner = doc.createElement('div')
        banner.className = 'gf-banner'
        banner.setAttribute('aria-live', 'polite')
        const spinner = doc.createElement('span')
        spinner.className = 'gf-spinner'
        spinner.setAttribute('aria-hidden', 'true')
        banner.appendChild(spinner)
        const text = doc.createElement('span')
        text.className = 'gf-banner__text'
        text.textContent = 'Fast results in · AI refining…'
        banner.appendChild(text)
        panel.appendChild(banner)
    }
    // Corrections list — exactly today's rows: per-correction diff +
    // per-row Apply. Hidden when paused or when count is 0 (the empty
    // action-row panel still opens for Recheck / Rephrase / Power).
    if (!options.disabled && options.corrections.length > 0) {
        const n = options.corrections.length
        const rows = options.corrections
            .map((c, i) => {
                // Strip the per-row category dot — the orb already shows
                // the band-color score ring; the per-row dot is a holdover
                // from the old W1 pill and isn't in the W2 reference DC.
                return (
                    `<button class="gf-pill-panel__row" data-action="apply-one" data-index="${i}" type="button">` +
                    diffInnerHTML(c.diffOriginal, c.diffCorrected, c.diffIsDeletion) +
                    `</button>`
                )
            })
            .join('')
        const header = doc.createElement('div')
        header.className = 'gf-pill-panel__header'
        header.textContent = `${n} correction${n === 1 ? '' : 's'}`
        const list = doc.createElement('div')
        list.className = 'gf-pill-panel__list'
        list.innerHTML = rows
        panel.append(header, list)
    }
    // Action row — always present: Apply all (count>0) · Undo · Recheck ·
    // Rephrase · Power. The paused-site panel short-circuits to just the
    // Enable affordance.
    panel.appendChild(buildActionRow(doc, options))
    return panel
}

function buildActionRow(doc: Document, options: StatusButtonOptions): HTMLElement {
    const row = doc.createElement('div')
    row.className = 'gf-pill-panel__actions'
    const add = (
        action: string,
        svg: string | null,
        label: string,
        opts?: { disabled?: boolean },
    ): void => {
        const btn = doc.createElement('button')
        btn.type = 'button'
        btn.className = 'gf-pill-panel__action'
        btn.dataset.action = action
        if (opts?.disabled) {
            btn.disabled = true
            btn.setAttribute('aria-disabled', 'true')
        }
        if (svg) btn.appendChild(svgFromConstant(doc, svg))
        const text = doc.createElement('span')
        text.textContent = label
        btn.appendChild(text)
        row.appendChild(btn)
    }
    if (options.disabled) {
        add('power', POWER_SVG, 'Enable')
        return row
    }
    if (options.count > 0) add('apply-all', null, 'Apply all')
    add('undo', UNDO_SVG, 'Undo', { disabled: !options.undoAvailable })
    add('recheck', REFRESH_SVG, 'Recheck')
    if (options.onRephrase) add('rephrase', REPHRASE_SVG, 'Rephrase')
    add('power', POWER_SVG, 'Disable on this site')
    return row
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

// arcOffset + BAND_COLOR are imported above for the JS-side arc.setAttribute
// calls in renderBody(); reference them here so dead-code elimination doesn't
// strip the import if the call sites change shape in a refactor. The compile-
// time `void` lets a linter see they're used, the runtime cost is one
// property read per render. Kept at the bottom so the file's story still
// reads "import → render → helpers."
void arcOffset
void BAND_COLOR
