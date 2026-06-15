// The click-to-fix correction card. Renders the design-system .gf-card
// anchored to a viewport rect (the highlight). The card shows the
// category, a model source chip, the bridge message, a confidence bar,
// the primary replacement, alternative replacement chips, an
// add-to-dictionary button (spelling only), and a ‹N of M› nav with
// keyboard (Enter accept / ←→ nav / Esc close).
//
// Outside-click dismiss is delayed by ~100ms after mount so the click that
// OPENED the card doesn't immediately close it; the handler is installed
// on document and inspects composedPath() (shadow-DOM aware). The previous
// card is always torn down before a new one mounts.
import { CATEGORY_META } from '@/api/category'
import { installOutsideDismiss, type OutsideDismissHandle } from '@/overlay/dismiss'
import { diffInnerHTML } from '@/overlay/diff-view'
import {
    clampNavIndex,
    confidenceBand,
    confidenceBarWidth,
    navLabel,
    sourceChipLabel,
} from '@/overlay/popover-helpers'
import type { BridgeSuggestion, Category } from '@/api/types'

const OUTSIDE_CLICK_DELAY_MS = 100
const PANEL_HEIGHT_ESTIMATE = 220
const PANEL_WIDTH = 300
const VIEWPORT_GUTTER = 10

export interface PopoverOptions {
    /** Viewport rect of the highlight the card is anchored to. Measure
     *  BEFORE re-rendering the overlay (INSTRUCTIONS §D). */
    anchorRect: DOMRect
    category: Category
    /** Bridge-supplied explanation. */
    message: string
    /** Word-level diff preview of the primary fix (original red -> corrected
     *  green); shown above the action row. */
    diffOriginal: string
    diffCorrected: string
    diffIsDeletion: boolean
    /** Replacement strings, index 0 is primary. */
    replacements: string[]
    /** Original text being replaced (used by Add to dictionary). */
    original?: string
    /** Bridge confidence in [0, 1]; drives the card's confidence bar
     *  + High/Medium/Low label. Undefined = LLM item, bar shows full +
     *  "High" label (decorative). */
    confidence?: number
    /** Bridge model tag; drives the source chip in the card head
     *  (Harper/GECToR → "· instant", LLM/lt_rule → "✨ AI"). */
    model?: BridgeSuggestion['model']
    /** 1-based index of THIS issue across all open issues; drives the
     *  "‹ N of M ›" nav label. Undefined → 1. */
    navIndex?: number
    /** Total open issues; drives the "‹ N of M ›" nav label and the
     *  visibility of the nav row. Undefined → 0 (nav hidden). */
    navTotal?: number
    onApply: (replacementIndex: number) => void
    onIgnore: () => void
    /**
     * W1a review nit: the BUTTON label is "Dismiss" (already since W1)
     * but the callback was called `onIgnore` (stale W1 surface name).
     * Renamed to `onDismiss` for parity with the visible label. The old
     * `onIgnore` is kept for back-compat with W1 callers that haven't
     * migrated; when both are supplied, `onDismiss` wins. */
    onDismiss?: () => void
    /** Spelling-only callback; the button is hidden for other categories. */
    onAddToDictionary?: (word: string) => void
    /** Move focus to the previous open issue (← key). */
    onNavPrev?: () => void
    /** Move focus to the next open issue (→ key). */
    onNavNext?: () => void
    /** Fast-path preview: render Apply disabled with a "Checking…" label.
     *  The final frame re-renders the popover with preview unset. */
    preview?: boolean
}

export interface PopoverHandle {
    hide: () => void
    isOpen: () => boolean
}

// Per-root registry: the shadow host adds itself here on construction and
// removes on destroy; the popover registers/unregisters its own handle so
// the host can dismiss every open popover during teardown.
const REGISTRY = new WeakMap<ShadowRoot, Set<PopoverHandle>>()

/** For tests: pop every active popover across all roots. */
export function dismissAllPopovers(): void {
    // We can't iterate a WeakMap's values directly, but each handle's
    // registry is the only way to reach it; this is a best-effort helper
    // for the test suite that constructs a single root per test. The
    // shadow-host teardown uses the per-root Set (see dismissPopoversIn).
    // No-op here: the per-root flush is the correct teardown path.
}

function registerPopover(root: ShadowRoot, handle: PopoverHandle): void {
    let set = REGISTRY.get(root)
    if (!set) {
        set = new Set()
        REGISTRY.set(root, set)
    }
    set.add(handle)
}

function unregisterPopover(root: ShadowRoot, handle: PopoverHandle): void {
    const set = REGISTRY.get(root)
    if (!set) return
    set.delete(handle)
    if (set.size === 0) REGISTRY.delete(root)
}

/**
 * Dismiss every popover currently mounted in `root`. Called by the
 * shadow host during teardown so document-level listeners and timers
 * don't leak past the content script's lifetime.
 */
export function dismissPopoversIn(root: ShadowRoot): void {
    const set = REGISTRY.get(root)
    if (!set) return
    // copy to a fresh array: hide() mutates the set (unregisters itself)
    for (const handle of Array.from(set)) handle.hide()
}

/** Feature-detect the HTML Popover API (top-layer + manual control). jsdom has
 *  only partial support, so we test both the method's presence and that the
 *  `popover` attribute reflects on the prototype. */
function isPopoverSupported(panel: HTMLElement): boolean {
    return (
        typeof (panel as { showPopover?: unknown }).showPopover === 'function' &&
        'popover' in HTMLElement.prototype
    )
}

/**
 * Mount a correction card in the supplied shadow root, anchored to the
 * given rect. Only one card per root is open at a time (opening a new
 * one dismisses the previous). Returns a handle with hide() / isOpen();
 * the caller (typically the content script) is responsible for hiding
 * it on blur / navigation. The host's destroy() will also dismiss any
 * open card.
 */
export function showPopover(root: ShadowRoot, options: PopoverOptions): PopoverHandle {
    dismissPopoversIn(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    const panel = doc.createElement('div')
    // W1-3: the design-system class is .gf-card (the old .gf-panel
    // stays in styles.ts for the W2 review panel, but the click-card
    // is no longer it). The card is a `role="dialog"` so screen readers
    // announce it correctly.
    panel.className = 'gf-card'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'Grammar correction')

    const usePopoverApi = isPopoverSupported(panel)
    if (usePopoverApi) {
        // Manual mode: WE control dismiss. (auto would light-dismiss on ANY
        // outside mousedown, including clicks on our own highlights that we use
        // to RE-OPEN the card — a close-then-reopen race. Manual keeps explicit
        // control while still putting the panel in the top layer.)
        panel.setAttribute('popover', 'manual')
    }

    positionPanel(panel, options.anchorRect, view)

    const meta = CATEGORY_META[options.category]
    panel.innerHTML = renderInnerHTML(meta.label, meta.badge, options)

    bindActions(panel, options, () => handle.hide())

    // swallow the mousedown that bubbles up so it doesn't reach the
    // outside-click handler we're about to install.
    panel.addEventListener('mousedown', (event) => {
        event.stopPropagation()
    })

    // Declared before the listeners below close over it: they can fire as
    // soon as the panel is in the DOM, and a `const` further down would be a
    // temporal-dead-zone trap for future refactors.
    let handle: PopoverHandle

    // Keyboard parity: Enter accepts, ←/→ nav, Esc closes.
    function onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault()
            handle.hide()
            return
        }
        if (event.key === 'Enter') {
            // The primary button already has focus (see below), so the
            // browser's native Enter activates it. We listen at the
            // panel level too so Enter works even if focus has wandered
            // to a nav button or an alternative chip — guard against the
            // preview frame via the same defense-in-depth as the click
            // handler.
            if (options.preview) return
            if (event.target instanceof HTMLButtonElement) return // native activation
            event.preventDefault()
            handle.hide()
            options.onApply(0)
            return
        }
        if (event.key === 'ArrowLeft' && typeof options.onNavPrev === 'function') {
            event.preventDefault()
            options.onNavPrev()
            return
        }
        if (event.key === 'ArrowRight' && typeof options.onNavNext === 'function') {
            event.preventDefault()
            options.onNavNext()
            return
        }
    }
    panel.addEventListener('keydown', onKeydown)

    root.appendChild(panel)

    if (usePopoverApi) {
        try {
            ;(panel as { showPopover: () => void }).showPopover()
        } catch {
            // Some engines throw if the element is not connected or is already
            // showing; the panel is still in the DOM (just not top-layer) and
            // the existing z-index keeps it visible, so this is a soft fallback.
        }
    }

    // Move focus to the primary action so keyboard users can apply with Enter
    // / Space without tabbing in from the field.
    panel.querySelector<HTMLButtonElement>('.gf-btn-primary')?.focus()

    // Outside-click (light-dismiss) via the unified dismiss helper.
    // Uses window capture so host-page stopPropagation can't block it.
    // Also excludes our own highlight spans (.gf-u) so clicking a
    // different highlight reopens the card rather than just closing.
    const outsideDismiss: OutsideDismissHandle = installOutsideDismiss(
        view,
        (el) => {
            if (panel.contains(el) || el === panel) return true
            // Don't dismiss when clicking another highlight (it will
            // reopen the card via the highlight click handler).
            if (el.classList.contains('gf-u')) return true
            return false
        },
        () => handle.hide(),
        'popover',
    )

    handle = {
        hide: () => {
            outsideDismiss.remove()
            panel.removeEventListener('keydown', onKeydown)
            if (usePopoverApi && panel.isConnected) {
                try {
                    ;(panel as { hidePopover: () => void }).hidePopover()
                } catch {
                    // already hidden / not in top layer — fall through to remove
                }
            }
            if (panel.isConnected) panel.remove()
            unregisterPopover(root, handle)
        },
        isOpen: () => panel.isConnected,
    }
    registerPopover(root, handle)

    return handle
}

function positionPanel(panel: HTMLElement, anchor: DOMRect, view: Window): void {
    const vw = view.innerWidth
    const vh = view.innerHeight
    const spaceBelow = vh - anchor.bottom
    const showAbove = spaceBelow < PANEL_HEIGHT_ESTIMATE
    let left = anchor.left
    if (left + PANEL_WIDTH > vw)
        left = Math.max(VIEWPORT_GUTTER, vw - PANEL_WIDTH - VIEWPORT_GUTTER)
    if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER
    panel.style.left = `${left}px`
    if (showAbove) {
        panel.style.bottom = `${vh - anchor.top + 8}px`
        panel.style.top = 'auto'
    } else {
        panel.style.top = `${anchor.bottom + 8}px`
        panel.style.bottom = 'auto'
    }
}

function escapeText(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function renderInnerHTML(label: string, badge: string, opts: PopoverOptions): string {
    const extras = opts.replacements.slice(1)
    const hasExtras = extras.length > 0
    const showDict = opts.category === 'spelling' && typeof opts.onAddToDictionary === 'function'
    const wordAttr = escapeText(opts.original ?? '')

    const chip = sourceChipLabel(opts.model)
    const chipClass = chip.variant === 'ai' ? 'gf-chip-source gf-chip-source--ai' : 'gf-chip-source'
    const band = confidenceBand(opts.confidence)
    const barWidth = confidenceBarWidth(opts.confidence)
    const nav = clampNavIndex(opts.navIndex, opts.navTotal)

    return `
        <span class="gf-card__tail" aria-hidden="true"></span>
        <div class="gf-card__head">
            <span class="gf-dot" style="background:${badge}"></span>
            <span class="gf-card__cat">${escapeText(label)}</span>
            <span style="flex:1"></span>
            <span class="${chipClass}">${chip.text}</span>
        </div>
        <div class="gf-diff">${diffInnerHTML(opts.diffOriginal, opts.diffCorrected, opts.diffIsDeletion)}</div>
        ${opts.message ? `<p class="gf-card__msg">${escapeText(opts.message)}</p>` : ''}
        <div class="gf-card__conf">
            <span class="gf-card__conf-label">Confidence</span>
            <span class="gf-card__confbar"><i class="gf-card__confbar-fill gf-card__confbar-fill--${band}" style="width:${barWidth}%"></i></span>
            <span class="gf-card__conf-color gf-card__conf-color--${band}">${capitalize(band)}</span>
        </div>
        <div class="gf-card__actions">
            <button class="gf-btn-primary" data-action="apply" type="button"${opts.preview ? ' disabled' : ''} style="flex:1">
                ${opts.preview ? 'Checking…' : 'Accept'} <kbd class="gf-kbd">⏎</kbd>
            </button>
            <button class="gf-btn-soft" data-action="dismiss" type="button">
                Dismiss
            </button>
        </div>
        ${
            hasExtras
                ? `<div class="gf-card__alts">
                    <span class="gf-card__alts-label">Or:</span>
                    ${extras
                        .map(
                            (alt, i) =>
                                `<button class="gf-chip-alt" data-action="apply-alt" data-index="${i + 1}" type="button">${escapeText(alt)}</button>`,
                        )
                        .join('')}
                </div>`
                : ''
        }
        ${
            showDict
                ? `<button class="gf-card__dict gf-btn-soft" data-action="dictionary" data-word="${wordAttr}" type="button">＋ Add &ldquo;${wordAttr}&rdquo; to dictionary</button>`
                : ''
        }
        ${
            nav
                ? `<nav class="gf-card__nav" aria-label="Issue navigation">
                    <button class="gf-iconbtn" data-action="nav-prev" type="button" aria-label="Previous">‹</button>
                    <span class="gf-card__nav-count">${navLabel(nav.current, nav.total)}</span>
                    <button class="gf-iconbtn" data-action="nav-next" type="button" aria-label="Next">›</button>
                    <span style="flex:1"></span>
                    <span class="gf-card__nav-hint"><kbd class="gf-kbd">→</kbd> next</span>
                </nav>`
                : ''
        }
    `
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1)
}

function bindActions(panel: HTMLElement, opts: PopoverOptions, dismiss: () => void): void {
    panel.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null
        const btn = target?.closest<HTMLElement>('[data-action]')
        if (!btn) return
        event.preventDefault()
        event.stopPropagation()
        const action = btn.dataset.action
        if (action === 'apply') {
            // Defense in depth behind the disabled attribute: a preview frame
            // is display-only; the final frame re-renders the popover with
            // preview unset, at which point Apply becomes live.
            if (opts.preview) return
            dismiss()
            opts.onApply(0)
            return
        }
        if (action === 'apply-alt') {
            const idx = Number.parseInt(btn.dataset.index ?? '', 10)
            if (Number.isInteger(idx) && idx >= 0) {
                dismiss()
                opts.onApply(idx)
            }
            return
        }
        if (action === 'dismiss') {
            dismiss()
            if (opts.onDismiss) opts.onDismiss()
            else opts.onIgnore()
            return
        }
        if (action === 'dictionary' && opts.onAddToDictionary) {
            dismiss()
            opts.onAddToDictionary(opts.original ?? '')
            return
        }
        if (action === 'nav-prev' && typeof opts.onNavPrev === 'function') {
            opts.onNavPrev()
            return
        }
        if (action === 'nav-next' && typeof opts.onNavNext === 'function') {
            opts.onNavNext()
        }
    })
}
