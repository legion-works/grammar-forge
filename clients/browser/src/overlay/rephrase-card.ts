// W1-4 re-skin: ports the rephrase card to the design-system .gf-rephrase
// markup (head + scope seg + tone seg + result body + regenerate footer),
// adds the "Generating with {model}…" skeleton state, and exposes
// scope/tone/regenerate callbacks. The HTML Popover API top-layer trick is
// reused so the card paints above any page stacking context. Three
// variants share the same plumbing:
//   - showRephraseCard: result card with Accept / accept-alt / regenerate
//   - showRephrasePending: skeleton "Generating with {model}…" card
//   - showRephraseError: inline error message + Retry
// All variants use createElement + textContent for visible text (the bridge
// supplies the rephrased text; NEVER innerHTML with untrusted data).
// One-per-root (REGISTRY + dismiss-then-show).
const REPHRASE_CARD_WIDTH_FALLBACK = 320
const REPHRASE_CARD_HEIGHT_FALLBACK = 220
const VIEWPORT_GUTTER = 10

export type RephraseScope = 'sentence' | 'message'
export type RephraseTone = 'neutral' | 'formal' | 'casual'

const SCOPE_LABELS: Record<RephraseScope, string> = {
    sentence: 'This sentence',
    message: 'Whole message',
}

const TONE_OPTIONS: RephraseTone[] = ['neutral', 'formal', 'casual']
const SCOPE_OPTIONS: RephraseScope[] = ['sentence', 'message']

export interface RephraseCardOptions {
    /** Viewport rect the card is anchored to (the selection, or the
     *  trigger Rephrase button). ⚠️ Measure this BEFORE re-rendering the
     *  field — a detached span's getBoundingClientRect() is all zeros and
     *  the card lands off-screen. Caller-side invariant; the function
     *  itself never re-measures. (Spec: INSTRUCTIONS §D; mirror of
     *  tooltip.ts / popover.ts.) */
    anchorRect: DOMRect
    /** The original text the user had selected (read-only context). */
    original: string
    /** The bridge's primary rephrasing. Accept writes this back. */
    rephrased: string
    /** Optional bridge-supplied alternatives; one chip per item. */
    alternatives: string[]
    /** Active scope (mirrors the rephrase() request). Drives which
     *  .gf-seg in the scope group carries .is-active. */
    scope: RephraseScope
    /** Active tone (mirrors the rephrase() request). Drives which
     *  .gf-seg in the tone group carries .is-active. */
    tone: RephraseTone
    /** Accept clicked (primary or alt) — the caller mutates the field. */
    onAccept: (text: string) => void
    /** Close/dismiss (Escape, close button, or dismissRephraseCardsIn). */
    onClose: () => void
    /** User toggled the scope seg — caller re-issues rephrase() with the
     *  new scope and replaces the card with pending → result. */
    onScopeChange: (scope: RephraseScope) => void
    /** User toggled the tone seg — caller re-issues rephrase() with the
     *  new tone and replaces the card with pending → result. */
    onToneChange: (tone: RephraseTone) => void
    /** User clicked Regenerate — caller re-issues rephrase() with the
     *  same scope+tone and replaces the card with pending → result. */
    onRegenerate: () => void
    /** Faint model label in the head (e.g. "Gemma"). */
    modelLabel?: string
}

export interface RephrasePendingOptions {
    /** Viewport rect the card is anchored to. */
    anchorRect: DOMRect
    /** Close/dismiss. The pending card has no other actions. */
    onClose: () => void
    /** Model label used in the "Generating with {model}…" copy. */
    modelLabel?: string
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
        /** Faint model label appended to the header. */
        modelLabel?: string
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
    card.className = `gf-rephrase ${options.extraClass}`.trim()
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', options.label)

    const usePopoverApi = isPopoverSupported(card)
    if (usePopoverApi) {
        // Manual mode: WE control dismiss (matches popover.ts).
        card.setAttribute('popover', 'manual')
    }

    // Build the body first (caller-specific), then the standard header on top.
    options.build(card, doc)
    appendHeader(card, options.label, options.modelLabel)

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

/** Standard card header: ✨ Rephrase + optional faint model label + × close
 *  button. The model label is rendered as `.gf-faint` so it reads as
 *  secondary text against the primary heading. */
function appendHeader(card: HTMLElement, label: string, modelLabel?: string): void {
    const doc = card.ownerDocument
    const header = doc.createElement('div')
    header.className = 'gf-rephrase__head'
    const labelEl = doc.createElement('span')
    labelEl.className = 'gf-rephrase__head-label'
    labelEl.textContent = '\u2728 Rephrase'
    // The dialog aria-label is set in mountSimpleCard; the visible header
    // text is the heading for sighted users.
    labelEl.setAttribute('aria-hidden', 'true')
    header.appendChild(labelEl)
    if (modelLabel) {
        const faint = doc.createElement('span')
        faint.className = 'gf-faint'
        faint.textContent = `AI \u00b7 ${modelLabel}`
        header.appendChild(faint)
    }
    const spacer = doc.createElement('span')
    spacer.style.flex = '1'
    header.appendChild(spacer)
    const close = doc.createElement('button')
    close.className = 'gf-iconbtn'
    close.type = 'button'
    close.setAttribute('aria-label', 'Close')
    close.dataset.action = 'close'
    close.textContent = '\u00d7' // ×
    header.appendChild(close)
    card.appendChild(header)
}

/** Build a segmented control group. Returns a div with the
 *  `gf-seg-group` class containing one `gf-seg` button per option. The
 *  option whose value equals `active` gets `is-active`. Buttons carry
 *  `data-action` (the action to fire) and `data-value` (the option). */
function buildSegGroup(
    doc: Document,
    action: string,
    options: readonly string[],
    active: string,
    labels?: Record<string, string>,
): HTMLDivElement {
    const group = doc.createElement('div')
    group.className = 'gf-seg-group'
    for (const value of options) {
        const btn = doc.createElement('button')
        btn.type = 'button'
        btn.className = 'gf-seg'
        btn.dataset.action = action
        btn.dataset.value = value
        btn.textContent = labels?.[value] ?? value
        if (value === active) btn.classList.add('is-active')
        group.appendChild(btn)
    }
    return group
}

/**
 * Mount a rephrase result card in the supplied shadow root, anchored to
 * the given rect. Only one card per root at a time (a new one dismisses
 * the prior). Returns a handle with hide() / isOpen(); the caller hides
 * it on Accept or close, and the shadow host's destroy() will also
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
        modelLabel: options.modelLabel,
        onClose: options.onClose,
        onAction: (action, btn, handle) => {
            if (action === 'accept') {
                handle.hide()
                options.onAccept(options.rephrased)
                return
            }
            if (action === 'accept-alt') {
                const idx = Number.parseInt(btn.dataset.index ?? '', 10)
                if (Number.isInteger(idx) && idx >= 0 && idx < options.alternatives.length) {
                    const text = options.alternatives[idx] ?? ''
                    handle.hide()
                    options.onAccept(text)
                }
                return
            }
            if (action === 'scope') {
                const value = btn.dataset.value
                if (value === 'sentence' || value === 'message') {
                    options.onScopeChange(value)
                }
                return
            }
            if (action === 'tone') {
                const value = btn.dataset.value
                if (value === 'neutral' || value === 'formal' || value === 'casual') {
                    options.onToneChange(value)
                }
                return
            }
            if (action === 'regenerate') {
                options.onRegenerate()
            }
        },
        build: (card, doc) => buildResultBody(card, doc, options),
    })
}

/** Build the body of a result card (head + scope + tone + original +
 *  rephrased + Accept + alternatives + footer). */
function buildResultBody(card: HTMLElement, doc: Document, options: RephraseCardOptions): void {
    // Scope seg group.
    card.appendChild(buildSegGroup(doc, 'scope', SCOPE_OPTIONS, options.scope, SCOPE_LABELS))
    // Tone seg group.
    card.appendChild(buildSegGroup(doc, 'tone', TONE_OPTIONS, options.tone))

    // Original text (faded context, read-only).
    if (options.original) {
        const original = doc.createElement('div')
        original.className = 'gf-rephrase__original'
        original.textContent = options.original
        card.appendChild(original)
    }
    // Rephrased text (primary result). textContent — untrusted bridge text.
    const text = doc.createElement('div')
    text.className = 'gf-rephrase__text'
    text.textContent = options.rephrased
    card.appendChild(text)
    // Action row: Accept (primary).
    const accept = doc.createElement('button')
    accept.type = 'button'
    accept.className = 'gf-btn-primary gf-rephrase__accept'
    accept.dataset.action = 'accept'
    accept.textContent = 'Accept'
    card.appendChild(accept)

    // Alternatives (chips; clicking one applies it).
    if (options.alternatives.length > 0) {
        const opts = doc.createElement('div')
        opts.className = 'gf-rephrase__opts'
        const orLabel = doc.createElement('span')
        orLabel.className = 'gf-faint'
        orLabel.textContent = 'Or:'
        opts.appendChild(orLabel)
        for (let i = 0; i < options.alternatives.length; i++) {
            const alt = doc.createElement('button')
            alt.type = 'button'
            alt.className = 'gf-chip-alt gf-chip-alt--block'
            alt.dataset.action = 'accept-alt'
            alt.dataset.index = String(i)
            alt.textContent = options.alternatives[i] ?? ''
            opts.appendChild(alt)
        }
        card.appendChild(opts)
    }

    // Footer: Regenerate + "Click one to apply" hint.
    const foot = doc.createElement('div')
    foot.className = 'gf-rephrase__foot'
    const regen = doc.createElement('button')
    regen.type = 'button'
    regen.className = 'gf-btn-soft'
    regen.dataset.action = 'regenerate'
    regen.textContent = '\u21bb Regenerate'
    foot.appendChild(regen)
    const spacer = doc.createElement('span')
    spacer.style.flex = '1'
    foot.appendChild(spacer)
    const hint = doc.createElement('span')
    hint.className = 'gf-faint'
    hint.textContent = 'Click one to apply'
    foot.appendChild(hint)
    card.appendChild(foot)
}

/** Skeleton "Generating with {model}…" card shown while the LLM round-trip
 *  is in flight. One-per-root like the result card: showRephraseCard
 *  replaces it. */
export function showRephrasePending(
    root: ShadowRoot,
    options: RephrasePendingOptions,
): RephraseCardHandle {
    return mountSimpleCard(root, {
        anchorRect: options.anchorRect,
        extraClass: 'gf-rephrase--pending',
        label: 'Rephrasing',
        modelLabel: options.modelLabel,
        onClose: options.onClose,
        build: (card, doc) => {
            const row = doc.createElement('div')
            row.className = 'gf-rephrase__pending-row'
            const spinner = doc.createElement('span')
            spinner.className = 'gf-spinner'
            spinner.setAttribute('aria-hidden', 'true')
            row.appendChild(spinner)
            const label = doc.createElement('span')
            label.className = 'gf-rephrase__pending-label'
            label.textContent = options.modelLabel
                ? `Generating with ${options.modelLabel}\u2026`
                : 'Generating\u2026'
            row.appendChild(label)
            card.appendChild(row)

            // Two shimmer blocks (transform/background-position animation only).
            const skel1 = doc.createElement('div')
            skel1.className = 'gf-skel gf-rephrase__skel'
            const skel2 = doc.createElement('div')
            skel2.className = 'gf-skel gf-rephrase__skel'
            card.appendChild(skel1)
            card.appendChild(skel2)
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
        extraClass: 'gf-rephrase--error',
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
            msg.className = 'gf-rephrase__text'
            msg.textContent = options.message
            card.appendChild(msg)
            const actions = doc.createElement('div')
            actions.className = 'gf-rephrase__actions'
            const retry = doc.createElement('button')
            retry.className = 'gf-btn-primary'
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
