// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// The per-field status pill. Three responsibilities:
//   1. Show the issue count ("! 3 issues · 3 grammar" / "✓ No issues").
//   2. A power button to disable checking on this site (collapses the pill to
//      just the power icon; click again re-enables).
//   3. On hover (when there are issues), expand a panel listing each
//      correction as a red->green diff row (click a row = apply that one) with
//      an "Apply all" button.
// Anchored to the bottom-right corner of the field; positioned from its
// measured size after mount so a wide label never overflows the field edge.
import { CATEGORY_META } from '@/api/category'
import { diffInnerHTML } from '@/overlay/diff-view'
import type { Category } from '@/api/types'

const PILL_WIDTH_FALLBACK = 110
const PILL_HEIGHT_FALLBACK = 28
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
    /** Number of issues; 0 = clean state. */
    count: number
    /** Per-category breakdown for the pill label, e.g. { spelling: 3, grammar: 1 }. */
    byCategory?: Partial<Record<Category, number>>
    /** Viewport rect of the field the pill is anchored to. */
    anchorRect: DOMRect
    /** Collapsed power-only state (checking disabled on this site). */
    disabled: boolean
    /** Corrections for the hover panel (ignored when disabled / count 0). */
    corrections: PillCorrection[]
    /** Click the pill body — focus the field. */
    onFocusField: () => void
    /** Click the power button — toggle site disable. */
    onTogglePower: () => void
    /** Click the recheck button — force a fresh check of the field now. */
    onRecheck: () => void
    /** "Apply all" in the hover panel. */
    onApplyAll: () => void
    /** Click a single correction row in the hover panel. */
    onApplyOne: (index: number) => void
    /** Drag OFFSET from the field's default bottom-right anchor (dx,dy). When
     *  set, the pill is placed at (anchor + offset), clamped — so a dragged
     *  position is RELATIVE to the field and re-anchors as the field moves
     *  (scroll/reflow). Persisted across re-renders and the enabled↔disabled
     *  pill swap. */
    dragOffset?: { dx: number; dy: number }
    /** Called when the user finishes dragging; reports the new accumulated
     *  offset from the field's default anchor. */
    onDragMove?: (offset: { dx: number; dy: number }) => void
    /** Initial visibility (default true). The active per-field pill is
     *  FOCUS-ONLY: the orchestrator passes `false` when the field isn't focused
     *  at render time, then toggles via `handle.setVisible` on focus/blur. The
     *  disabled (site-paused) pill omits this (always visible). */
    initiallyVisible?: boolean
}

export interface StatusButtonHandle {
    destroy: () => void
    isMounted: () => boolean
    /** Re-anchor the pill to a fresh field rect, re-applying the live drag
     *  offset. Called by the shared scroll/resize loop so the pill tracks its
     *  field instead of staying pinned while the field scrolls away. */
    reposition: (anchorRect: DOMRect) => void
    /** Show/hide the pill without destroying it. The pill is FOCUS-ONLY: the
     *  orchestrator hides it on field blur and shows it on focus (a hidden pill
     *  is `display:none` so it neither paints nor intercepts pointer events,
     *  but its hover panel / drag state survive). */
    setVisible: (visible: boolean) => void
    /** Refresh the pill's count badge, category stripe bar, and hover-panel
     *  corrections IN PLACE (no teardown) when a new check resolves. Preserves
     *  the pill element, its drag offset + live drag, the hover-panel lifecycle,
     *  and the visibility (setVisible) state. A panel open at update time is
     *  closed (it reopens with fresh data on the next hover). */
    update: (options: StatusButtonOptions) => void
}

const POWER_SVG =
    `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ` +
    `stroke-width="2.4" stroke-linecap="round" aria-hidden="true">` +
    `<path d="M12 4 L12 12" /><path d="M7.5 6.5 A7 7 0 1 0 16.5 6.5" /></svg>`

const REFRESH_SVG =
    `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ` +
    `stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M20 11 A8 8 0 1 0 18.4 16"/><path d="M20 4 L20 11 L13 11"/></svg>`

/**
 * Render the per-field status pill (+ its hover panel) in the supplied shadow
 * root. Replaces any prior pill. The returned handle's destroy() removes the
 * pill AND the hover panel AND clears the hide timer + listeners.
 */
export function renderStatusButton(
    root: ShadowRoot,
    options: StatusButtonOptions,
): StatusButtonHandle {
    destroyExisting(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    // Mutable current options: update() swaps this in place so the badge/
    // stripe/corrections + the panel/click closures all read fresh data without
    // recreating the pill (and its drag state / listeners / visibility).
    let current = options

    const pill = doc.createElement('div')
    pill.className = 'gf-pill'
    if (current.disabled) pill.classList.add('gf-pill--disabled')

    // Power button (always present).
    const power = doc.createElement('button')
    power.type = 'button'
    power.className = 'gf-pill__power'
    power.setAttribute(
        'aria-label',
        current.disabled ? 'Enable grammar checking on this site' : 'Disable on this site',
    )
    power.title = power.getAttribute('aria-label') ?? ''
    power.innerHTML = POWER_SVG
    bindButton(power, () => current.onTogglePower())
    pill.appendChild(power)

    // Body (count) — only present in the enabled state. Held so update() can
    // refresh its innerHTML + aria-label in place.
    let body: HTMLButtonElement | null = null
    // Body (count) — hidden in the collapsed/disabled state.
    if (!current.disabled) {
        body = doc.createElement('button')
        body.type = 'button'
        body.className = 'gf-pill__body'
        bindButton(body, () => current.onFocusField())
        pill.appendChild(body)

        // Recheck button — force a fresh check of the field now.
        const recheck = doc.createElement('button')
        recheck.type = 'button'
        recheck.className = 'gf-pill__recheck'
        recheck.setAttribute('aria-label', 'Recheck now')
        recheck.title = 'Recheck now'
        recheck.innerHTML = REFRESH_SVG
        bindButton(recheck, () => current.onRecheck())
        pill.appendChild(recheck)
    }

    // Fill (or refill) the body's count badge + breakdown bar + aria-label from
    // `current`. Called on mount and on every update(). No-op when disabled
    // (no body element exists).
    const renderBody = (): void => {
        if (!body) return
        body.setAttribute(
            'aria-label',
            current.count === 0 ? 'No grammar issues' : `${current.count} grammar issues`,
        )
        body.innerHTML = buildBodyHTML(current)
    }
    renderBody()

    root.appendChild(pill)
    // Focus-only visibility: a hidden pill is display:none (no paint, no
    // pointer events) but keeps its drag/hover state. Default visible.
    if (current.initiallyVisible === false) pill.classList.add('gf-pill--hidden')
    // Live drag offset from the field's default bottom-right anchor. Seeded
    // from the persisted session offset; drag-end accumulates into it; the
    // shared scroll/resize loop re-anchors via `reposition` using this value.
    let currentOffset = current.dragOffset ?? { dx: 0, dy: 0 }
    positionPill(pill, current.anchorRect, view, currentOffset)

    // Pointer-drag (session). A move past DRAG_THRESHOLD_PX starts a drag; a
    // plain click (no move) still reaches the inner buttons. On drop, report the
    // new offset from the field's default bottom-right anchor.
    let dragStart: { x: number; y: number; left: number; top: number } | null = null
    let dragged = false
    const onPointerDown = (e: PointerEvent): void => {
        if (e.button !== 0) return
        // Start from the AUTHORITATIVE transform translate (what positionPill
        // set), NOT pill.offsetLeft/Top: the pill is position:fixed at 0,0 with
        // a transform offset, so offsetLeft is layout-derived and can differ
        // from our translate — reading it caused a visual jump at drag start.
        const t = readTranslate(pill)
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
            // pointerdown retargets the subsequent `click` to the pill, which
            // swallowed clicks on the inner power/recheck buttons. (setPointerCapture
            // is missing from the jsdom test build — guard it.)
            if (typeof pill.setPointerCapture === 'function') pill.setPointerCapture(e.pointerId)
        }
        dragged = true
        pill.classList.add('gf-pill--dragging')
        // Position via transform (composited, no reflow); left/top stay 0.
        pill.style.transform = `translate(${dragStart.left + ddx}px, ${dragStart.top + ddy}px)`
    }
    const onPointerUp = (e: PointerEvent): void => {
        if (!dragStart) return
        try {
            if (typeof pill.releasePointerCapture === 'function')
                pill.releasePointerCapture(e.pointerId)
        } catch {
            /* not captured */
        }
        if (dragged) {
            pill.classList.remove('gf-pill--dragging')
            const ddx = e.clientX - dragStart.x
            const ddy = e.clientY - dragStart.y
            // Accumulate this drag's delta into the field-relative offset so the
            // pill keeps tracking its field (the shared scroll/resize loop calls
            // reposition with this offset) and the spot persists across
            // re-renders and the enabled↔disabled pill swap.
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
    // Pressing the pill (anywhere — the draggable surface, the gaps, the
    // badge) must NOT blur the focused field. Without this, mousedown's default
    // action moves focus off the textarea → the orchestrator's blur handler
    // hides the focus-only pill mid-press, and the in-flight drag dies on a
    // now-`display:none` element. The inner buttons already preventDefault
    // their own mousedown (bindButton); this covers everything else. We do NOT
    // stopPropagation (nothing above needs the event) and do NOT preventDefault
    // pointer/click events, so dragging + button clicks still work.
    const onPillMouseDown = (e: MouseEvent): void => {
        e.preventDefault()
    }
    pill.addEventListener('mousedown', onPillMouseDown)
    pill.addEventListener('pointerdown', onPointerDown)
    pill.addEventListener('pointermove', onPointerMove)
    pill.addEventListener('pointerup', onPointerUp)
    pill.addEventListener('click', onClickCapture, { capture: true })

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
        if (panel || current.disabled || current.corrections.length === 0) return
        panel = buildPanel(doc, current)
        root.appendChild(panel)
        positionPanel(panel, pill.getBoundingClientRect(), view)
        panel.addEventListener('mouseenter', clearHide)
        panel.addEventListener('mouseleave', scheduleHide)
        panel.addEventListener('mousedown', (e) => e.stopPropagation())
        panel.addEventListener('click', (event) => {
            const target = event.target as HTMLElement | null
            const btn = target?.closest<HTMLElement>('[data-action]')
            if (!btn) return
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
            }
        })
    }

    pill.addEventListener('mouseenter', () => {
        clearHide()
        showPanel()
    })
    pill.addEventListener('mouseleave', scheduleHide)

    return {
        destroy: () => {
            hidePanel()
            pill.remove()
        },
        isMounted: () => pill.isConnected,
        reposition: (anchorRect: DOMRect) => positionPill(pill, anchorRect, view, currentOffset),
        setVisible: (visible: boolean) => {
            pill.classList.toggle('gf-pill--hidden', !visible)
        },
        update: (next: StatusButtonOptions) => {
            current = next
            pill.classList.toggle('gf-pill--disabled', current.disabled)
            renderBody()
            // A panel open at update time is closed; it reopens on the next
            // hover with fresh corrections (update happens per-check, not
            // per-hover, so this is invisible in practice).
            hidePanel()
        },
    }
}

/** Read the pill's current transform translate offset (x,y in px). Returns
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
    root.querySelectorAll('.gf-pill, .gf-pill-panel').forEach((el) => el.remove())
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
    // offset so a dragged pill re-anchors to the field as it moves.
    const left = anchor.right - width - VIEWPORT_GUTTER + offset.dx
    const top = anchor.bottom - height - VIEWPORT_GUTTER + offset.dy
    // The pill is BOUND to its field: clamp so it can't escape the field's box
    // (a drag can move it within the field, but never outside it), then clamp
    // to the viewport as a final safety. For a field smaller than the pill the
    // field-clamp pins the pill to the field's bottom-right corner.
    const pos = clampToRect({ left, top }, width, height, anchor)
    positionAbsolute(pill, pos, view)
}

/**
 * Clamp a top-left position so a `width`×`height` box stays inside `rect`
 * (inset by VIEWPORT_GUTTER). When the box is larger than the rect on an axis,
 * the box is pinned to the rect's far (right/bottom) edge — so the pill stays
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
    // (min > max) the far-edge pin wins (pill clings to bottom-right corner).
    if (left > maxLeft) left = maxLeft
    if (left < minLeft) left = minLeft
    if (top > maxTop) top = maxTop
    if (top < minTop) top = minTop
    return { left, top }
}

/** Place the pill at an absolute viewport position, clamped into the viewport. */
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
    // Position via transform (composited, no reflow). The pill stays
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
    // Right-align the panel to the pill, sitting just ABOVE it (no gap, so the
    // pointer can travel pill -> panel without leaving the hover group).
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
    const n = options.corrections.length
    const rows = options.corrections
        .map((c, i) => {
            const dot = CATEGORY_META[c.category].badge
            return (
                `<button class="gf-pill-panel__row" data-action="apply-one" data-index="${i}" type="button">` +
                `<span class="gf-pill-panel__dot" style="background:${dot}"></span>` +
                diffInnerHTML(c.diffOriginal, c.diffCorrected, c.diffIsDeletion) +
                `</button>`
            )
        })
        .join('')
    panel.innerHTML =
        `<div class="gf-pill-panel__header">${n} correction${n === 1 ? '' : 's'}</div>` +
        `<div class="gf-pill-panel__list">${rows}</div>` +
        `<button class="gf-pill-panel__apply-all" data-action="apply-all" type="button">Apply all</button>`
    return panel
}

function buildBodyHTML(options: StatusButtonOptions): string {
    // The pill shows only a compact count badge + the per-category colour bar.
    // The full "N issues · M spelling · …" breakdown lives in the toolbar popup
    // (popup "Focused field" section), so the pill stays small + unobtrusive.
    if (options.count === 0) {
        return `<span class="gf-pill__badge gf-pill__badge--ok" aria-hidden="true">✓</span>`
    }
    return (
        `<span class="gf-pill__badge" aria-live="polite" aria-atomic="true">${options.count}</span>` +
        buildBreakdownBar(options.byCategory)
    )
}

function buildBreakdownBar(byCategory: StatusButtonOptions['byCategory']): string {
    if (!byCategory) return ''
    const order: Category[] = [
        'spelling',
        'grammar',
        'punctuation',
        'style',
        'typography',
        'unknown',
    ]
    const stripes = order
        .filter((c) => (byCategory[c] ?? 0) > 0)
        .map((c) => {
            const n = byCategory[c] ?? 0
            const color = CATEGORY_META[c].badge
            return `<span class="gf-pill-bar__stripe" style="flex-grow:${n};background:${color}" aria-hidden="true"></span>`
        })
        .join('')
    return stripes ? `<span class="gf-pill-bar" aria-hidden="true">${stripes}</span>` : ''
}
