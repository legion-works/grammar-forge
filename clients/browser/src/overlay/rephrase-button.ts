// A small floating split control shown near a text selection — the entry
// point to the bridge rephrase flow AND (Feature 2, interaction redesign)
// the Synonyms popover. One container (`.gf-rephrase-btn`, role="group"),
// two real <button> segments (primary "Rephrase", secondary "Synonyms")
// separated by a hairline divider. Only one control per root (a new one
// dismisses the prior). No document-level listeners or timers of its own —
// hide() is just a node removal, mirroring showTooltip's lifecycle; the
// orchestrator owns the selectionchange debounce that decides when to
// show/hide it.
//
// Previously (pre-redesign) this rendered a single "Rephrase" button and a
// double-click on a clean word auto-opened Synonyms directly. That
// auto-open trigger is REMOVED (Feature 2c) — Synonyms is now reached only
// via this control's secondary segment, gated on the selection being a
// single "clean" word (@/overlay/synonyms's `isSingleCleanWordSelection`).
const REPHRASE_BUTTON_WIDTH_FALLBACK = 168
const REPHRASE_BUTTON_HEIGHT_FALLBACK = 32
const VIEWPORT_GUTTER = 8
const ANCHOR_GAP = 6

export interface RephraseButtonOptions {
    /** Viewport rect of the selection the control is anchored to. */
    anchorRect: DOMRect
    /** Click handler for the primary "Rephrase" segment — the orchestrator's
     *  entry into the rephrase flow. Unchanged from the pre-split button. */
    onClick: () => void
    /** Whether the Synonyms segment is actionable for the current selection
     *  (a single clean word — reuse `isSingleCleanWordSelection`). Defaults
     *  to false: callers that don't pass it get a disabled segment. */
    synonymsEnabled?: boolean
    /** Click handler for the Synonyms segment. Only wired when
     *  `synonymsEnabled` is true; ignored otherwise (the segment renders
     *  `disabled` and native disabled semantics stop the click). */
    onSynonymsClick?: () => void
    /** Explains why Synonyms is disabled — set as the segment's `title`
     *  and surfaced via `aria-disabled` for assistive tech. Only used when
     *  `synonymsEnabled` is false. */
    synonymsDisabledReason?: string
    /**
     * Placement audit: optional viewport rect of host chrome the control
     * must clear (mirrors synonyms.ts's `clearRect`). Vencord's Discord
     * composer anchors a floating selection-formatting toolbar (B/I/U/…)
     * above ANY selection, and the composer itself sits at the bottom of
     * the screen — the control flips above the selection and, without
     * this, sat flush against (or under) that host chrome. The synonyms
     * popover already clears this rect; the split control did not. When
     * omitted (the browser client, which has no such host chrome), the
     * control positions exactly as before.
     */
    clearRect?: DOMRect
}

export interface RephraseButtonHandle {
    hide: () => void
    isOpen: () => boolean
}

/**
 * Mount the Rephrase/Synonyms split control in the supplied shadow root,
 * anchored to the given selection rect. Only one control per root at a time
 * (a new one dismisses the prior). Returns a handle with hide() / isOpen();
 * the caller hides it on dismiss or on swap-in to the rephrase card / the
 * synonyms popover.
 */
export function showRephraseButton(
    root: ShadowRoot,
    options: RephraseButtonOptions,
): RephraseButtonHandle {
    dismissRephraseButtonsIn(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    const container = doc.createElement('div')
    container.className = 'gf-rephrase-btn'
    container.setAttribute('role', 'group')
    container.setAttribute('aria-label', 'Rephrase and synonyms')

    // mousedown preventDefault on BOTH segments so the field doesn't lose
    // focus / caret (a user click on either segment while the field is
    // focused must not blur the field — the field stays editable AND the
    // segment's click still fires). Mirror bindButton in status-button.ts.
    const preventFocusSteal = (event: Event): void => {
        event.preventDefault()
        event.stopPropagation()
    }

    const primary = doc.createElement('button')
    primary.className = 'gf-rephrase-btn__primary'
    primary.type = 'button'
    primary.textContent = '✨ Rephrase'
    primary.addEventListener('mousedown', preventFocusSteal)
    primary.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        options.onClick()
    })
    container.appendChild(primary)

    const divider = doc.createElement('span')
    divider.className = 'gf-rephrase-btn__divider'
    divider.setAttribute('aria-hidden', 'true')
    container.appendChild(divider)

    const synonyms = doc.createElement('button')
    synonyms.className = 'gf-rephrase-btn__synonyms'
    synonyms.type = 'button'
    synonyms.textContent = 'Synonyms'
    if (options.synonymsEnabled) {
        synonyms.addEventListener('mousedown', preventFocusSteal)
        synonyms.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            options.onSynonymsClick?.()
        })
    } else {
        synonyms.disabled = true
        synonyms.setAttribute('aria-disabled', 'true')
        if (options.synonymsDisabledReason) synonyms.title = options.synonymsDisabledReason
    }
    container.appendChild(synonyms)

    positionRephraseButton(container, options.anchorRect, view, options.clearRect)
    root.appendChild(container)

    return {
        hide: () => {
            if (container.isConnected) container.remove()
        },
        isOpen: () => container.isConnected,
    }
}

/** Remove every Rephrase/Synonyms split control mounted in `root`. Used on
 *  teardown. */
export function dismissRephraseButtonsIn(root: ShadowRoot): void {
    root.querySelectorAll('.gf-rephrase-btn').forEach((el) => el.remove())
}

function positionRephraseButton(
    container: HTMLElement,
    anchor: DOMRect,
    view: Window,
    clear?: DOMRect,
): void {
    const vw = view.innerWidth
    const vh = view.innerHeight
    const width = container.offsetWidth || REPHRASE_BUTTON_WIDTH_FALLBACK
    // Default anchor: just below-left of the selection. Flip above if there
    // is no room below (mirrors tooltip's showAbove heuristic).
    const spaceBelow = vh - anchor.bottom
    const showAbove = spaceBelow < REPHRASE_BUTTON_HEIGHT_FALLBACK + ANCHOR_GAP
    let left = anchor.left
    if (left + width > vw - VIEWPORT_GUTTER) {
        left = Math.max(VIEWPORT_GUTTER, vw - width - VIEWPORT_GUTTER)
    }
    if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER
    container.style.left = `${left}px`
    // Placement audit: when `clear` (host chrome, e.g. Discord's composer +
    // its floating selection-formatting toolbar) is supplied, widen the
    // edge the control clears past just the selection — mirrors
    // synonyms.ts's positionPopover. The selection alone is not enough in
    // Discord: the selection sits INSIDE the composer, so clearing only the
    // selection still let the control overlap the composer chrome.
    if (showAbove) {
        const aboveEdge = clear ? Math.min(anchor.top, clear.top) : anchor.top
        container.style.bottom = `${vh - aboveEdge + ANCHOR_GAP}px`
        container.style.top = 'auto'
    } else {
        const belowEdge = clear ? Math.max(anchor.bottom, clear.bottom) : anchor.bottom
        container.style.top = `${belowEdge + ANCHOR_GAP}px`
        container.style.bottom = 'auto'
    }
}
