// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// The per-field "1 issue" / "✓ No issues" status pill. Anchored to the
// bottom-right corner of the field; on click it surfaces the per-category
// count (or "no issues" in the clean state).
import type { Category } from '@/api/types'

export interface StatusButtonOptions {
    /** Number of issues; 0 = clean state. */
    count: number
    /** Per-category breakdown for the pill label, e.g. { spelling: 3, grammar: 1 }. */
    byCategory?: Partial<Record<Category, number>>
    /** Viewport rect of the field the pill is anchored to. */
    anchorRect: DOMRect
    onClick: () => void
}

export interface StatusButtonHandle {
    destroy: () => void
    isMounted: () => boolean
}

// Fallbacks only — the pill is positioned from its MEASURED size after mount
// (jsdom returns offsetWidth 0, so the fallbacks keep tests deterministic).
const PILL_WIDTH_FALLBACK = 110
const PILL_HEIGHT_FALLBACK = 28
const VIEWPORT_GUTTER = 8

/**
 * Render the per-field status pill in the supplied shadow root. Replaces
 * any prior pill. Clicking the pill fires `onClick`; mousedown is
 * preventDefault'd so the field doesn't lose focus.
 */
export function renderStatusButton(
    root: ShadowRoot,
    options: StatusButtonOptions,
): StatusButtonHandle {
    destroyExisting(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    const pill = doc.createElement('button')
    pill.type = 'button'
    pill.className = 'gf-pill'
    pill.setAttribute(
        'aria-label',
        options.count === 0 ? 'No grammar issues' : `${options.count} grammar issues`,
    )

    pill.innerHTML = buildInnerHTML(options)

    pill.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
    })
    pill.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        options.onClick()
    })

    root.appendChild(pill)
    // Position AFTER mount so offsetWidth/offsetHeight reflect the REAL
    // rendered size. The label width varies with the category summary
    // (e.g. "3 issues · 3 grammar"); a hardcoded width mis-placed the pill
    // and clipped it against the field's right edge.
    positionPill(pill, options.anchorRect, view)
    return {
        destroy: () => pill.remove(),
        isMounted: () => pill.isConnected,
    }
}

function destroyExisting(root: ShadowRoot): void {
    root.querySelectorAll('.gf-pill').forEach((el) => el.remove())
}

function positionPill(pill: HTMLElement, anchor: DOMRect, view: Window): void {
    const vw = view.innerWidth
    const vh = view.innerHeight
    // Use the pill's MEASURED size (set after mount); fall back to constants
    // when layout is unavailable (jsdom). This is what fixes the clipping: the
    // right edge is aligned to the field's right edge minus the real width.
    const width = pill.offsetWidth || PILL_WIDTH_FALLBACK
    const height = pill.offsetHeight || PILL_HEIGHT_FALLBACK
    // Anchor inside the field's bottom-right corner, a gutter from each edge.
    let left = anchor.right - width - VIEWPORT_GUTTER
    let top = anchor.bottom - height - VIEWPORT_GUTTER
    // Clamp into the viewport.
    if (left > vw - width - VIEWPORT_GUTTER) left = vw - width - VIEWPORT_GUTTER
    if (top > vh - height - VIEWPORT_GUTTER) top = vh - height - VIEWPORT_GUTTER
    if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER
    if (top < VIEWPORT_GUTTER) top = VIEWPORT_GUTTER
    pill.style.left = `${left}px`
    pill.style.top = `${top}px`
}

function buildInnerHTML(options: StatusButtonOptions): string {
    if (options.count === 0) {
        return `
            <span aria-hidden="true" style="color:#22c55e">✓</span>
            <span>No issues</span>
        `
    }
    const summary = buildCategorySummary(options.byCategory)
    return `
        <span aria-hidden="true" style="color:#ef4444">!</span>
        <span>${options.count} issue${options.count === 1 ? '' : 's'}</span>
        ${summary ? `<span style="opacity:.7">·</span><span>${summary}</span>` : ''}
    `
}

function buildCategorySummary(byCategory: StatusButtonOptions['byCategory']): string {
    if (!byCategory) return ''
    const parts: string[] = []
    // stable order: most-severe first
    const order: Category[] = [
        'spelling',
        'grammar',
        'punctuation',
        'style',
        'typography',
        'unknown',
    ]
    for (const c of order) {
        const n = byCategory[c]
        if (n && n > 0) parts.push(`${n} ${c}`)
    }
    return parts.join(' · ')
}
