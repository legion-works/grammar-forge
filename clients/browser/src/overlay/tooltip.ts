// Lightweight hover tooltip — a minimal "preview pill" (category dot +
// diff). The popover (click → actionable card) is the single source of
// rich information; the hover chip is intentionally stripped down to a
// glanceable diff so it never duplicates the card. pointer-events:none
// keeps the field fully editable/selectable under it; the orchestrator
// shows/hides it.
import { CATEGORY_META } from '@/api/category'
import { diffInnerHTML } from '@/overlay/diff-view'
import type { Category } from '@/api/types'

const TOOLTIP_WIDTH_MAX = 320
const TOOLTIP_HEIGHT_ESTIMATE = 36
const VIEWPORT_GUTTER = 10
const ANCHOR_GAP = 6

export interface TooltipOptions {
    /**
     * Viewport rect of the edit (word) the tooltip is anchored to.
     * ⚠️ The orchestrator MUST measure this BEFORE re-rendering the
     * underline overlay — a detached node's getBoundingClientRect() is
     * all zeros and the pill lands off-screen. (Spec: INSTRUCTIONS §D.)
     * The tooltip takes the rect as a plain value so the ordering is a
     * caller-side invariant; the function itself never re-measures.
     */
    anchorRect: DOMRect
    category: Category
    /** Word-level diff: original word(s) (shown red, struck) -> corrected
     *  word(s) (shown green). e.g. "was" -> "were". */
    diffOriginal: string
    diffCorrected: string
    /** True when the correction removes the text (no green side). */
    diffIsDeletion: boolean
    /** Quick-accept callback — fires when the user clicks the ✓ button in
     *  the hover pill. The orchestrator applies the primary replacement,
     *  shows the Undo toast, and hides the tooltip. Optional: omit to
     *  render the pill without the accept button (e.g. when the item has
     *  no replacement). */
    onAccept?: () => void
    /** Hover-bridge: called when the pointer enters the pill itself.
     *  The orchestrator cancels the hide-grace timer so the pill stays
     *  open while the user moves from the word to the ✓ button. */
    onPillMouseEnter?: () => void
    /** Hover-bridge: called when the pointer leaves the pill. The
     *  orchestrator re-arms the hide-grace timer. */
    onPillMouseLeave?: () => void
}

export interface TooltipHandle {
    hide: () => void
    isOpen: () => boolean
}

/**
 * Mount a hover chip in the supplied shadow root, anchored to the given
 * rect. Only one chip per root at a time (a new one dismisses the prior).
 * Returns a handle with hide() / isOpen(); the caller hides it on
 * mouse-leave, on opening the click card, and on teardown. The chip holds
 * no listeners or timers, so hide() is just a node removal.
 */
export function showTooltip(root: ShadowRoot, options: TooltipOptions): TooltipHandle {
    dismissTooltipsIn(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    const tip = doc.createElement('div')
    // W1-2: the design-system class is `.gf-tip` (the old `.gf-tooltip`
    // is gone). The matching tail is appended as `.gf-tip__tail` so the
    // CSS can draw a downward caret pointing at the word.
    tip.className = 'gf-tip'
    tip.id = 'gf-chip'
    tip.setAttribute('role', 'tooltip')
    // When an accept button is present the pill needs pointer-events so
    // the button is clickable. Without onAccept the pill stays inert.
    if (options.onAccept) tip.style.pointerEvents = 'auto'

    const meta = CATEGORY_META[options.category]
    tip.innerHTML = renderInnerHTML(meta.badge, options)

    // Wire the quick-accept button (rendered by renderInnerHTML when
    // onAccept is provided). mousedown preventDefault keeps the field
    // focused; click fires the accept callback.
    if (options.onAccept) {
        const btn = tip.querySelector<HTMLButtonElement>('.gf-tip__accept')
        if (btn) {
            btn.addEventListener('mousedown', (e) => e.preventDefault())
            btn.addEventListener('click', (e) => {
                e.preventDefault()
                e.stopPropagation()
                options.onAccept!()
            })
        }
    }

    // Hover-bridge: keep the pill alive while the pointer is over it so
    // the user can move from the word to the ✓ button without the pill
    // vanishing. The orchestrator cancels/re-arms the hide-grace timer.
    if (options.onPillMouseEnter) {
        tip.addEventListener('mouseenter', options.onPillMouseEnter)
    }
    if (options.onPillMouseLeave) {
        tip.addEventListener('mouseleave', options.onPillMouseLeave)
    }

    // Append first so the browser lays out the pill and offsetWidth is
    // the ACTUAL rendered width (not TOOLTIP_WIDTH_MAX which over-shifts
    // the pill left when the content is short, e.g. "a → an ✓").
    // Position off-screen initially to avoid a flash at the wrong spot.
    tip.style.left = '-9999px'
    tip.style.top = '-9999px'
    root.appendChild(tip)
    // Now measure the actual rendered width and reposition correctly.
    positionTooltip(tip, options.anchorRect, view)

    return {
        hide: () => {
            if (tip.isConnected) tip.remove()
        },
        isOpen: () => tip.isConnected,
    }
}

/** Remove every tooltip mounted in `root`. Used on teardown. */
export function dismissTooltipsIn(root: ShadowRoot): void {
    root.querySelectorAll('.gf-tip').forEach((el) => el.remove())
}

function positionTooltip(tip: HTMLElement, anchor: DOMRect, view: Window): void {
    const vw = view.innerWidth
    const vh = view.innerHeight
    // Use actual rendered dimensions (measured after mount at left:-9999px).
    // Falls back to constants when offsetWidth/Height is 0 (jsdom).
    const pillWidth = tip.offsetWidth > 0 ? tip.offsetWidth : TOOLTIP_WIDTH_MAX
    const pillHeight = tip.offsetHeight > 0 ? tip.offsetHeight : TOOLTIP_HEIGHT_ESTIMATE

    // DEFAULT: place ABOVE the word (DC: pill sits above, caret points down).
    // FLIP BELOW only when there isn't room above (word too close to top).
    const spaceAbove = anchor.top - VIEWPORT_GUTTER
    const showBelow = spaceAbove < pillHeight + ANCHOR_GAP

    // Horizontal: center on the word. Caret (left:50%) points at pill center
    // = word center. Clamp to viewport.
    const wordCenterX = anchor.left + anchor.width / 2
    let left = wordCenterX - pillWidth / 2
    if (left + pillWidth > vw - VIEWPORT_GUTTER) left = vw - pillWidth - VIEWPORT_GUTTER
    if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER
    tip.style.left = `${left}px`

    // Vertical + caret direction.
    if (showBelow) {
        // No room above → place below, caret points UP. Placement audit
        // (HOVER PILL): also clamp to the BOTTOM of the viewport — a word
        // near the top edge of a short viewport (the case that triggers
        // this branch) can still overflow the bottom if the pill is tall,
        // otherwise rendering (partially) off-screen and invisible.
        const top = Math.min(anchor.bottom + ANCHOR_GAP, vh - pillHeight - VIEWPORT_GUTTER)
        tip.style.top = `${top}px`
        tip.style.bottom = 'auto'
        tip.classList.add('gf-tip--below')
    } else {
        // Default: place above, caret points DOWN.
        const top = anchor.top - pillHeight - ANCHOR_GAP
        tip.style.top = `${Math.max(VIEWPORT_GUTTER, top)}px`
        tip.style.bottom = 'auto'
        tip.classList.remove('gf-tip--below')
    }
}

function renderInnerHTML(badge: string, opts: TooltipOptions): string {
    // The diff fragment is already built (.gf-diff with __old/__arrow/
    // __new) by diffInnerHTML; the tip wraps it with the category dot,
    // an optional quick-accept button (DC: .gf-pillok, ✓ green button),
    // and the downward caret (gf-tip__tail).
    const acceptBtn = opts.onAccept && !opts.diffIsDeletion
        ? `<button class="gf-tip__accept" type="button" title="Accept suggestion" aria-label="Accept suggestion">&#x2713;</button>`
        : ''
    return (
        `<span class="gf-tip__dot" style="background:${badge}"></span>` +
        diffInnerHTML(opts.diffOriginal, opts.diffCorrected, opts.diffIsDeletion) +
        acceptBtn +
        `<span class="gf-tip__tail" aria-hidden="true"></span>`
    )
}
