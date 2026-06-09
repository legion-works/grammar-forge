// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// The click-to-fix popover. Renders a glass panel anchored to a viewport
// rect (the underline). The panel shows the category, the bridge message,
// the primary replacement, and an action row: Apply · "Show N more" (when
// there are alternatives) · Ignore once · Add to dictionary (spelling only).
//
// Outside-click dismiss is delayed by ~100ms after mount so the click that
// OPENED the popover doesn't immediately close it; the handler is installed
// on document and inspects composedPath() (shadow-DOM aware). The previous
// popover is always torn down before a new one mounts.
import { CATEGORY_META } from '@/api/category'
import type { Category } from '@/api/types'

const OUTSIDE_CLICK_DELAY_MS = 100
const PANEL_HEIGHT_ESTIMATE = 220
const PANEL_WIDTH = 300
const VIEWPORT_GUTTER = 10

export interface PopoverOptions {
    /** Viewport rect of the underline the popover is anchored to. */
    anchorRect: DOMRect
    category: Category
    /** Bridge-supplied explanation. */
    message: string
    /** Replacement strings, index 0 is primary. */
    replacements: string[]
    /** Original text being replaced (used by Add to dictionary). */
    original?: string
    onApply: (replacementIndex: number) => void
    onIgnore: () => void
    /** Spelling-only callback; the button is hidden for other categories. */
    onAddToDictionary?: (word: string) => void
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

/**
 * Mount a popover in the supplied shadow root, anchored to the given rect.
 * Only one popover per root is open at a time (opening a new one dismisses
 * the previous). Returns a handle with hide() / isOpen(); the caller
 * (typically the content script) is responsible for hiding it on blur /
 * navigation. The host's destroy() will also dismiss any open popover.
 */
export function showPopover(root: ShadowRoot, options: PopoverOptions): PopoverHandle {
    dismissPopoversIn(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    const panel = doc.createElement('div')
    panel.className = 'gf-panel'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'Grammar correction')

    positionPanel(panel, options.anchorRect, view)

    const meta = CATEGORY_META[options.category]
    panel.innerHTML = renderInnerHTML(meta.label, meta.badge, options)

    bindActions(panel, options, () => handle.hide())

    // swallow the mousedown that bubbles up so it doesn't reach the
    // outside-click handler we're about to install.
    panel.addEventListener('mousedown', (event) => {
        event.stopPropagation()
    })

    root.appendChild(panel)

    let outsideListenerInstalled = false
    function onOutsideMouseDown(event: MouseEvent): void {
        if (!panel.isConnected) return
        // composedPath() crosses shadow boundaries; if the click was inside
        // the popover (or one of our underlines that is about to reopen us),
        // bail.
        const path = event.composedPath()
        if (path.includes(panel)) return
        const underlines = root.querySelectorAll('.gf-underline')
        for (const u of underlines) {
            if (path.includes(u)) return
        }
        handle.hide()
    }
    // Outside-click: install after a short delay so the click that opened
    // us doesn't dismiss us in the same tick.
    const outsideTimer = view.setTimeout(() => {
        outsideListenerInstalled = true
        doc.addEventListener('mousedown', onOutsideMouseDown, true)
    }, OUTSIDE_CLICK_DELAY_MS)

    const handle: PopoverHandle = {
        hide: () => {
            view.clearTimeout(outsideTimer)
            if (outsideListenerInstalled) {
                doc.removeEventListener('mousedown', onOutsideMouseDown, true)
                outsideListenerInstalled = false
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
    const primary = opts.replacements[0] ?? ''
    const extras = opts.replacements.slice(1)
    const hasExtras = extras.length > 0
    const showDict = opts.category === 'spelling' && typeof opts.onAddToDictionary === 'function'
    const wordAttr = escapeText(opts.original ?? '')
    return `
        <div class="gf-panel__header">
            <span class="gf-panel__dot" style="background:${badge}"></span>
            <span class="gf-panel__label">${escapeText(label)}</span>
        </div>
        <div class="gf-panel__message">${escapeText(opts.message)}</div>
        <div class="gf-panel__message">
            <span class="gf-panel__replacement">${escapeText(primary)}</span>
        </div>
        <div class="gf-panel__actions">
            <button class="gf-panel__btn gf-panel__btn--primary" data-action="apply" type="button">
                Apply
            </button>
            ${
                hasExtras
                    ? `<button class="gf-panel__btn" data-action="more" type="button">Show ${extras.length} more</button>`
                    : ''
            }
            <button class="gf-panel__btn gf-panel__btn--ghost" data-action="ignore" type="button">
                Ignore once
            </button>
            ${
                showDict
                    ? `<button class="gf-panel__btn gf-panel__btn--ghost" data-action="dictionary" data-word="${wordAttr}" type="button">Add to dictionary</button>`
                    : ''
            }
        </div>
    `
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
            dismiss()
            opts.onApply(0)
            return
        }
        if (action === 'ignore') {
            dismiss()
            opts.onIgnore()
            return
        }
        if (action === 'more') {
            // reveal alternatives inline; render fresh children rather than
            // toggling visibility so the panel can grow naturally.
            const list = panel.ownerDocument.createElement('div')
            list.className = 'gf-panel__alternatives'
            for (let i = 1; i < opts.replacements.length; i++) {
                const alt = panel.ownerDocument.createElement('button')
                alt.type = 'button'
                alt.className = 'gf-panel__alternative'
                alt.dataset.action = 'apply-alt'
                alt.dataset.index = String(i)
                alt.textContent = opts.replacements[i] ?? ''
                list.appendChild(alt)
            }
            // remove the "Show N more" trigger; the list now sits in its place
            btn.remove()
            panel.appendChild(list)
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
        if (action === 'dictionary' && opts.onAddToDictionary) {
            dismiss()
            opts.onAddToDictionary(opts.original ?? '')
        }
    })
}
