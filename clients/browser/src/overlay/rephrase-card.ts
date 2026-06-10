// Adapted from the popover's "apply-correction card" pattern (re-uses the
// HTML Popover API top-layer trick so the card paints above any page
// stacking context). Three variants share the same plumbing:
//   - showRephraseCard: result card with Apply / Apply-alt / close
//   - showRephrasePending: lightweight "Rephrasing…" card (no actions)
//   - showRephraseError: inline error message + Retry
// All variants use createElement + textContent for visible text (the bridge
// supplies the rephrased text; NEVER innerHTML with untrusted data). One-per-
// root (REGISTRY + dismiss-then-show).
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

export interface RephrasePendingOptions {
    /** Viewport rect the card is anchored to. */
    anchorRect: DOMRect
    /** Close/dismiss. The pending card has no other actions. */
    onClose: () => void
}

export interface RephraseErrorOptions {
    /** Viewport rect the card is anchored to. */
    anchorRect: DOMRect
    /** Error text shown in the card body. UNTRUSTED — textContent only. */
    message: string
    /** Retry clicked — the caller re-shows pending and re-issues the request. */
    onRetry: () => void
    /** Close/dismiss. */
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
 * Mount a rephrase card in the supplied shadow root. Shared by all three
 * variants (result / pending / error): one-per-root, popover=manual when
 * supported, dismiss-then-create, positionCard, Escape/close handling,
 * registry bookkeeping, and a `[data-action]` click dispatcher that handles
 * `close` itself and forwards anything else to `onAction`.
 */
function mountSimpleCard(
    root: ShadowRoot,
    options: {
        anchorRect: DOMRect
        /** Extra class added to the card root (e.g. --pending / --error). */
        extraClass: string
        /** Header label text. */
        label: string
        /** Build the card body (called BEFORE the header is appended so the
         *  caller can populate the card with their own elements). */
        build: (card: HTMLElement, doc: Document) => void
        onClose: () => void
        /** Optional dispatcher for non-close data-action clicks. Receives the
         *  originating button element so dataset.index (and similar) can be
         *  read by the caller. */
        onAction?: (action: string, btn: HTMLElement, handle: RephraseCardHandle) => void
    },
): RephraseCardHandle {
    dismissRephraseCardsIn(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    const card = doc.createElement('div')
    card.className = `gf-rephrase-card ${options.extraClass}`.trim()
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', options.label)

    const usePopoverApi = isPopoverSupported(card)
    if (usePopoverApi) {
        // Manual mode: WE control dismiss (matches popover.ts).
        card.setAttribute('popover', 'manual')
    }

    // Build the body first (caller-specific), then the standard header on top.
    options.build(card, doc)
    appendHeader(card, options.label)

    positionCard(card, options.anchorRect, view)

    // Swallow the mousedown that bubbles up so it doesn't reach the
    // outside-click handler the orchestrator may install. Defensive and
    // consistent with popover.ts.
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

    // Action dispatch. `close` is handled here; anything else goes to
    // `onAction` (which may swallow / dispatch / etc.). The originating button
    // element is passed through so the caller can read dataset.index etc.
    card.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null
        const btn = target?.closest<HTMLElement>('[data-action]')
        if (!btn) return
        event.preventDefault()
        event.stopPropagation()
        const action = btn.dataset.action
        if (action === 'close') {
            handle.hide()
            options.onClose()
            return
        }
        options.onAction?.(action ?? '', btn, handle)
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

/** Standard card header: label on the left, × close button on the right. */
function appendHeader(card: HTMLElement, label: string): void {
    const doc = card.ownerDocument
    const header = doc.createElement('div')
    header.className = 'gf-rephrase-card__header'
    const labelEl = doc.createElement('span')
    labelEl.className = 'gf-rephrase-card__label'
    labelEl.textContent = label
    const close = doc.createElement('button')
    close.className = 'gf-rephrase-card__close'
    close.type = 'button'
    close.setAttribute('aria-label', 'Close')
    close.dataset.action = 'close'
    close.textContent = '\u00d7' // ×
    header.append(labelEl, close)
    card.appendChild(header)
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
    return mountSimpleCard(root, {
        anchorRect: options.anchorRect,
        extraClass: '',
        label: 'Rephrase',
        onClose: options.onClose,
        onAction: (action, btn, handle) => {
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
            }
        },
        build: (card, doc) => buildResultBody(card, doc, options),
    })
}

/** Build the body of a result card (original + rephrased + Apply row). */
function buildResultBody(card: HTMLElement, doc: Document, options: RephraseCardOptions): void {
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
    // Action row: Apply (primary) + one button per alternative.
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

/** Lightweight "Rephrasing…" card shown while the LLM round-trip is in
 *  flight. One-per-root like the result card: showRephraseCard replaces it. */
export function showRephrasePending(
    root: ShadowRoot,
    options: RephrasePendingOptions,
): RephraseCardHandle {
    return mountSimpleCard(root, {
        anchorRect: options.anchorRect,
        extraClass: 'gf-rephrase-card--pending',
        label: 'Rephrasing',
        onClose: options.onClose,
        build: (card, doc) => {
            const spinner = doc.createElement('span')
            spinner.className = 'gf-rephrase-card__spinner'
            spinner.setAttribute('aria-hidden', 'true')
            const msg = doc.createElement('span')
            msg.textContent = 'Rephrasing…'
            const row = doc.createElement('div')
            row.className = 'gf-rephrase-card__pending-row'
            row.append(spinner, msg)
            card.appendChild(row)
        },
    })
}

/** Error card with a Retry affordance. */
export function showRephraseError(
    root: ShadowRoot,
    options: RephraseErrorOptions,
): RephraseCardHandle {
    return mountSimpleCard(root, {
        anchorRect: options.anchorRect,
        extraClass: 'gf-rephrase-card--error',
        label: 'Rephrase',
        onClose: options.onClose,
        onAction: (action, _btn, handle) => {
            if (action === 'retry') {
                handle.hide()
                options.onRetry()
            }
        },
        build: (card, doc) => {
            const msg = doc.createElement('div')
            msg.className = 'gf-rephrase-card__text'
            msg.textContent = options.message
            card.appendChild(msg)
            const actions = doc.createElement('div')
            actions.className = 'gf-rephrase-card__actions'
            const retry = doc.createElement('button')
            retry.className = 'gf-rephrase-card__btn gf-rephrase-card__btn--primary'
            retry.type = 'button'
            retry.dataset.action = 'retry'
            retry.textContent = 'Retry'
            actions.appendChild(retry)
            card.appendChild(actions)
        },
    })
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
