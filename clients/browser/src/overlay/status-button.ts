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
}

export interface StatusButtonHandle {
    destroy: () => void
    isMounted: () => boolean
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

    const pill = doc.createElement('div')
    pill.className = 'gf-pill'
    if (options.disabled) pill.classList.add('gf-pill--disabled')

    // Power button (always present).
    const power = doc.createElement('button')
    power.type = 'button'
    power.className = 'gf-pill__power'
    power.setAttribute(
        'aria-label',
        options.disabled ? 'Enable grammar checking on this site' : 'Disable on this site',
    )
    power.title = power.getAttribute('aria-label') ?? ''
    power.innerHTML = POWER_SVG
    bindButton(power, options.onTogglePower)
    pill.appendChild(power)

    // Body (count) — hidden in the collapsed/disabled state.
    if (!options.disabled) {
        const body = doc.createElement('button')
        body.type = 'button'
        body.className = 'gf-pill__body'
        body.setAttribute(
            'aria-label',
            options.count === 0 ? 'No grammar issues' : `${options.count} grammar issues`,
        )
        body.innerHTML = buildBodyHTML(options)
        bindButton(body, options.onFocusField)
        pill.appendChild(body)

        // Recheck button — force a fresh check of the field now.
        const recheck = doc.createElement('button')
        recheck.type = 'button'
        recheck.className = 'gf-pill__recheck'
        recheck.setAttribute('aria-label', 'Recheck now')
        recheck.title = 'Recheck now'
        recheck.innerHTML = REFRESH_SVG
        bindButton(recheck, options.onRecheck)
        pill.appendChild(recheck)
    }

    root.appendChild(pill)
    positionPill(pill, options.anchorRect, view)

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
        if (panel || options.disabled || options.corrections.length === 0) return
        panel = buildPanel(doc, options)
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
                options.onApplyAll()
                return
            }
            if (btn.dataset.action === 'apply-one') {
                const i = Number.parseInt(btn.dataset.index ?? '', 10)
                if (Number.isInteger(i)) {
                    hidePanel()
                    options.onApplyOne(i)
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
    root.querySelectorAll('.gf-pill, .gf-pill-panel').forEach((el) => el.remove())
}

function positionPill(pill: HTMLElement, anchor: DOMRect, view: Window): void {
    const vw = view.innerWidth
    const vh = view.innerHeight
    const width = pill.offsetWidth || PILL_WIDTH_FALLBACK
    const height = pill.offsetHeight || PILL_HEIGHT_FALLBACK
    let left = anchor.right - width - VIEWPORT_GUTTER
    // top-right by default: sit just inside the field's top edge
    let top = anchor.top + VIEWPORT_GUTTER
    // flip below the top edge only if it would clip the viewport top
    if (top < VIEWPORT_GUTTER) top = VIEWPORT_GUTTER
    if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER
    if (left > vw - width - VIEWPORT_GUTTER) left = vw - width - VIEWPORT_GUTTER
    if (top > vh - height - VIEWPORT_GUTTER) top = vh - height - VIEWPORT_GUTTER
    pill.style.left = `${left}px`
    pill.style.top = `${top}px`
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

function escapeText(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
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
    if (options.count === 0) {
        return `<span aria-hidden="true" style="color:#22c55e">✓</span> <span>No issues</span>`
    }
    const summary = buildCategorySummary(options.byCategory)
    return (
        `<span aria-hidden="true" style="color:#ef4444">!</span> ` +
        `<span aria-live="polite" aria-atomic="true">` +
        `<span>${options.count} issue${options.count === 1 ? '' : 's'}</span>` +
        (summary ? ` <span style="opacity:.7">·</span> <span>${escapeText(summary)}</span>` : '') +
        `</span>` +
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

function buildCategorySummary(byCategory: StatusButtonOptions['byCategory']): string {
    if (!byCategory) return ''
    const parts: string[] = []
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
