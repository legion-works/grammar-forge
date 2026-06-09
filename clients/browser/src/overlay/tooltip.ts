// Lightweight hover tooltip (read-only). Shows the category, the bridge
// message, and the primary fix for the edit under the pointer. Unlike the
// popover (click -> actionable card), the tooltip has NO buttons and installs
// NO document-level listeners or timers: it is purely informational and is
// shown/hidden by the content orchestrator on hover. It is pointer-events:none
// so it never intercepts the page's mouse events (the field stays fully
// editable and selectable under it).
import { CATEGORY_META } from '@/api/category'
import { diffInnerHTML, escapeText } from '@/overlay/diff-view'
import type { Category } from '@/api/types'

const TOOLTIP_WIDTH_MAX = 320
const TOOLTIP_HEIGHT_ESTIMATE = 72
const VIEWPORT_GUTTER = 10
const ANCHOR_GAP = 6

export interface TooltipOptions {
    /** Viewport rect of the edit (word) the tooltip is anchored to. */
    anchorRect: DOMRect
    category: Category
    /** Bridge-supplied explanation. May be empty. */
    message: string
    /** Word-level diff: original word(s) (shown red, struck) -> corrected
     *  word(s) (shown green). e.g. "was" -> "were". */
    diffOriginal: string
    diffCorrected: string
    /** True when the correction removes the text (no green side). */
    diffIsDeletion: boolean
}

export interface TooltipHandle {
    hide: () => void
    isOpen: () => boolean
}

/**
 * Mount a hover tooltip in the supplied shadow root, anchored to the given
 * rect. Only one tooltip per root at a time (a new one dismisses the prior).
 * Returns a handle with hide() / isOpen(); the caller hides it on mouse-leave,
 * on opening the click card, and on teardown. The tooltip holds no listeners
 * or timers, so hide() is just a node removal.
 */
export function showTooltip(root: ShadowRoot, options: TooltipOptions): TooltipHandle {
    dismissTooltipsIn(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    const tip = doc.createElement('div')
    tip.className = 'gf-tooltip'
    tip.setAttribute('role', 'tooltip')

    const meta = CATEGORY_META[options.category]
    tip.innerHTML = renderInnerHTML(meta.label, meta.badge, options)

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
    root.querySelectorAll('.gf-tooltip').forEach((el) => el.remove())
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
        tip.style.bottom = `${vh - anchor.top + ANCHOR_GAP}px`
        tip.style.top = 'auto'
    } else {
        tip.style.top = `${anchor.bottom + ANCHOR_GAP}px`
        tip.style.bottom = 'auto'
    }
}

function renderInnerHTML(label: string, badge: string, opts: TooltipOptions): string {
    const hasMessage = opts.message.trim().length > 0
    return `
        <div class="gf-tooltip__header">
            <span class="gf-tooltip__dot" style="background:${badge}"></span>
            <span class="gf-tooltip__label">${escapeText(label)}</span>
        </div>
        ${hasMessage ? `<div class="gf-tooltip__message">${escapeText(opts.message)}</div>` : ''}
        <div class="gf-tooltip__fix">${diffInnerHTML(opts.diffOriginal, opts.diffCorrected, opts.diffIsDeletion)}</div>
        <div class="gf-tooltip__hint">Click to fix</div>
    `
}
