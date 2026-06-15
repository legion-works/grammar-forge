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
const TOOLTIP_HEIGHT_ESTIMATE = 72
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

    positionTooltip(tip, options.anchorRect, view)
    root.appendChild(tip)

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
    const spaceBelow = vh - anchor.bottom
    const showAbove = spaceBelow < TOOLTIP_HEIGHT_ESTIMATE
    let left = anchor.left
    if (left + TOOLTIP_WIDTH_MAX > vw) {
        left = Math.max(VIEWPORT_GUTTER, vw - TOOLTIP_WIDTH_MAX - VIEWPORT_GUTTER)
    }
    if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER
    tip.style.left = `${left}px`
    if (showAbove) {
        // Bug-fix: was `bottom: vh - anchor.top + ANCHOR_GAP` which is a
        // CSS `bottom` value on a position:fixed element — that means
        // "distance from viewport bottom", not "distance from viewport top".
        // `vh - anchor.top + 6` = a large value that pushes the pill far
        // off-screen. Use `top` instead: anchor.top - tipHeight - gap.
        // We don't know tipHeight before layout, so use the estimate.
        const estimatedTop = anchor.top - TOOLTIP_HEIGHT_ESTIMATE - ANCHOR_GAP
        tip.style.top = `${Math.max(VIEWPORT_GUTTER, estimatedTop)}px`
        tip.style.bottom = 'auto'
    } else {
        tip.style.top = `${anchor.bottom + ANCHOR_GAP}px`
        tip.style.bottom = 'auto'
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
