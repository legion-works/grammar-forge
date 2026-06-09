// Adapted from the popover's "apply-correction card" pattern (re-uses the
// HTML Popover API top-layer trick so the card paints above any page
// stacking context). Shows the bridge's rephrased text + alternatives
// with an Apply button per option; Escape or a close button calls
// onClose. The rephrased text + alternatives are bridge/LLM-sourced and
// UNTRUSTED, so we build all visible text via textContent (never
// innerHTML for user data). One-per-root (REGISTRY + dismiss-then-show).
const REPHRASE_CARD_WIDTH_FALLBACK = 320
const REPHRASE_CARD_HEIGHT_FALLBACK = 220
const VIEWPORT_GUTTER = 10

export interface RephraseCardOptions {
    /** Viewport rect the card is anchored to (e.g. the selection, or the
     *  trigger Rephrase button). */
    anchorRect: DOMRect
    /** The original text the user had selected (read-only context). */
    original: string
    /** The bridge's primary rephrasing. Apply writes this back. */
    rephrased: string
    /** Optional bridge-supplied alternatives; one button per item. */
    alternatives: string[]
    /** Apply clicked (primary or alt) — the caller mutates the field. */
    onApply: (text: string) => void
    /** Close/dismiss (Escape, close button, or dismissRephraseCardsIn). */
    onClose: () => void
}

export interface RephraseCardHandle {
    hide: () => void
    isOpen: () => boolean
}

// Per-root registry: the card registers/unregisters its own handle so
// the shadow host (and dismissRephraseCardsIn) can flush every open
// card during teardown. Mirror of popover.ts's REGISTRY.
const REGISTRY = new WeakMap<ShadowRoot, Set<RephraseCardHandle>>()

function registerCard(root: ShadowRoot, handle: RephraseCardHandle): void {
    let set = REGISTRY.get(root)
    if (!set) {
        set = new Set()
        REGISTRY.set(root, set)
    }
    set.add(handle)
}

function unregisterCard(root: ShadowRoot, handle: RephraseCardHandle): void {
    const set = REGISTRY.get(root)
    if (!set) return
    set.delete(handle)
    if (set.size === 0) REGISTRY.delete(root)
}

/** Dismiss every rephrase card mounted in `root`. Called on teardown. */
export function dismissRephraseCardsIn(root: ShadowRoot): void {
    const set = REGISTRY.get(root)
    if (!set) return
    // copy to a fresh array: hide() mutates the set (unregisters itself)
    for (const handle of Array.from(set)) handle.hide()
}

/** Feature-detect the HTML Popover API (top-layer + manual control). */
function isPopoverSupported(panel: HTMLElement): boolean {
    return (
        typeof (panel as { showPopover?: unknown }).showPopover === 'function' &&
        'popover' in HTMLElement.prototype
    )
}

/**
 * Mount a rephrase result card in the supplied shadow root, anchored to
 * the given rect. Only one card per root at a time (a new one dismisses
 * the prior). Returns a handle with hide() / isOpen(); the caller hides
 * it on Apply or close, and the shadow host's destroy() will also
 * dismiss any open card.
 */
export function showRephraseCard(
    root: ShadowRoot,
    options: RephraseCardOptions,
): RephraseCardHandle {
    dismissRephraseCardsIn(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    const card = doc.createElement('div')
    card.className = 'gf-rephrase-card'
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', 'Rephrase')

    const usePopoverApi = isPopoverSupported(card)
    if (usePopoverApi) {
        // Manual mode: WE control dismiss (matches popover.ts).
        card.setAttribute('popover', 'manual')
    }

    buildCardContent(card, options)
    positionCard(card, options.anchorRect, view)

    // Swallow the mousedown that bubbles up so it doesn't reach the
    // outside-click handler the orchestrator may install. (The card
    // itself doesn't install one — but defensive, and consistent with
    // popover.ts.)
    card.addEventListener('mousedown', (event) => {
        event.stopPropagation()
    })

    // Escape closes (keyboard parity with popover).
    function onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault()
            handle.hide()
            options.onClose()
        }
    }
    card.addEventListener('keydown', onKeydown)

    // Action dispatch (Apply primary / Apply alt / Close).
    card.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null
        const btn = target?.closest<HTMLElement>('[data-action]')
        if (!btn) return
        event.preventDefault()
        event.stopPropagation()
        const action = btn.dataset.action
        if (action === 'apply') {
            handle.hide()
            options.onApply(options.rephrased)
            return
        }
        if (action === 'apply-alt') {
            const idx = Number.parseInt(btn.dataset.index ?? '', 10)
            if (Number.isInteger(idx) && idx >= 0 && idx < options.alternatives.length) {
                const text = options.alternatives[idx] ?? ''
                handle.hide()
                options.onApply(text)
            }
            return
        }
        if (action === 'close') {
            handle.hide()
            options.onClose()
        }
    })

    root.appendChild(card)

    if (usePopoverApi) {
        try {
            ;(card as { showPopover: () => void }).showPopover()
        } catch {
            // already showing / not connected — fall through; the z-index
            // keeps it visible outside the top layer.
        }
    }

    const handle: RephraseCardHandle = {
        hide: () => {
            card.removeEventListener('keydown', onKeydown)
            if (usePopoverApi && card.isConnected) {
                try {
                    ;(card as { hidePopover: () => void }).hidePopover()
                } catch {
                    // already hidden / not in top layer — fall through to remove
                }
            }
            if (card.isConnected) card.remove()
            unregisterCard(root, handle)
        },
        isOpen: () => card.isConnected,
    }
    registerCard(root, handle)

    return handle
}

function buildCardContent(card: HTMLElement, options: RephraseCardOptions): void {
    const doc = card.ownerDocument

    // Header: "Rephrase" label + a small close button (×). The close
    // button is a real affordance for users who don't reach for Escape.
    const header = doc.createElement('div')
    header.className = 'gf-rephrase-card__header'
    const label = doc.createElement('span')
    label.className = 'gf-rephrase-card__label'
    label.textContent = 'Rephrase'
    const close = doc.createElement('button')
    close.className = 'gf-rephrase-card__close'
    close.type = 'button'
    close.setAttribute('aria-label', 'Close')
    close.dataset.action = 'close'
    close.textContent = '\u00d7' // ×
    header.append(label, close)
    card.appendChild(header)

    // Original text (faded context, read-only).
    if (options.original) {
        const original = doc.createElement('div')
        original.className = 'gf-rephrase-card__original'
        original.textContent = options.original
        card.appendChild(original)
    }

    // Rephrased text (primary result). textContent — untrusted bridge text.
    const text = doc.createElement('div')
    text.className = 'gf-rephrase-card__text'
    text.textContent = options.rephrased
    card.appendChild(text)

    // Action row: Apply (primary) + one button per alternative. Built with
    // createElement + textContent (NO innerHTML for user data).
    const actions = doc.createElement('div')
    actions.className = 'gf-rephrase-card__actions'
    const apply = doc.createElement('button')
    apply.className = 'gf-rephrase-card__btn gf-rephrase-card__btn--primary'
    apply.type = 'button'
    apply.dataset.action = 'apply'
    apply.textContent = 'Apply'
    actions.appendChild(apply)
    for (let i = 0; i < options.alternatives.length; i++) {
        const alt = doc.createElement('button')
        alt.className = 'gf-rephrase-card__btn'
        alt.type = 'button'
        alt.dataset.action = 'apply-alt'
        alt.dataset.index = String(i)
        alt.textContent = options.alternatives[i] ?? ''
        actions.appendChild(alt)
    }
    card.appendChild(actions)
}

function positionCard(card: HTMLElement, anchor: DOMRect, view: Window): void {
    const vw = view.innerWidth
    const vh = view.innerHeight
    const width = card.offsetWidth || REPHRASE_CARD_WIDTH_FALLBACK
    const height = card.offsetHeight || REPHRASE_CARD_HEIGHT_FALLBACK
    const spaceBelow = vh - anchor.bottom
    const showAbove = spaceBelow < height
    let left = anchor.left
    if (left + width > vw - VIEWPORT_GUTTER) {
        left = Math.max(VIEWPORT_GUTTER, vw - width - VIEWPORT_GUTTER)
    }
    if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER
    card.style.left = `${left}px`
    if (showAbove) {
        card.style.bottom = `${vh - anchor.top + 8}px`
        card.style.top = 'auto'
    } else {
        card.style.top = `${anchor.bottom + 8}px`
        card.style.bottom = 'auto'
    }
}
