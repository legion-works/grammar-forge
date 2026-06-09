// A small floating "Rephrase" button shown near a text selection. Acts as
// the entry point to the bridge rephrase flow: the orchestrator positions
// it just below-left of the selection rect, the user clicks, and the
// orchestrator swaps in a rephrase-card. One-per-root (a new button
// dismisses the prior). No document-level listeners or timers, so hide()
// is just a node removal — mirror of showTooltip's lifecycle.
const REPHRASE_BUTTON_WIDTH_FALLBACK = 96
const REPHRASE_BUTTON_HEIGHT_FALLBACK = 32
const VIEWPORT_GUTTER = 8
const ANCHOR_GAP = 6

export interface RephraseButtonOptions {
    /** Viewport rect of the selection the button is anchored to. */
    anchorRect: DOMRect
    /** Click handler — the orchestrator's entry into the rephrase flow. */
    onClick: () => void
}

export interface RephraseButtonHandle {
    hide: () => void
    isOpen: () => boolean
}

/**
 * Mount a Rephrase button in the supplied shadow root, anchored to the
 * given selection rect. Only one button per root at a time (a new one
 * dismisses the prior). Returns a handle with hide() / isOpen(); the
 * caller hides it on dismiss or on swap-in to the rephrase card.
 */
export function showRephraseButton(
    root: ShadowRoot,
    options: RephraseButtonOptions,
): RephraseButtonHandle {
    dismissRephraseButtonsIn(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    const btn = doc.createElement('button')
    btn.className = 'gf-rephrase-btn'
    btn.type = 'button'
    btn.textContent = 'Rephrase'

    // mousedown preventDefault so the field doesn't lose focus / caret
    // (a user click on the button while the field is focused must not
    // blur the field — the field stays editable AND the button's click
    // still fires). Mirror bindButton in status-button.ts.
    btn.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
    })
    btn.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        options.onClick()
    })

    positionRephraseButton(btn, options.anchorRect, view)
    root.appendChild(btn)

    return {
        hide: () => {
            if (btn.isConnected) btn.remove()
        },
        isOpen: () => btn.isConnected,
    }
}

/** Remove every Rephrase button mounted in `root`. Used on teardown. */
export function dismissRephraseButtonsIn(root: ShadowRoot): void {
    root.querySelectorAll('.gf-rephrase-btn').forEach((el) => el.remove())
}

function positionRephraseButton(btn: HTMLElement, anchor: DOMRect, view: Window): void {
    const vw = view.innerWidth
    const vh = view.innerHeight
    const width = btn.offsetWidth || REPHRASE_BUTTON_WIDTH_FALLBACK
    // Default anchor: just below-left of the selection. Flip above if there
    // is no room below (mirrors tooltip's showAbove heuristic).
    const spaceBelow = vh - anchor.bottom
    const showAbove = spaceBelow < REPHRASE_BUTTON_HEIGHT_FALLBACK + ANCHOR_GAP
    let left = anchor.left
    if (left + width > vw - VIEWPORT_GUTTER) {
        left = Math.max(VIEWPORT_GUTTER, vw - width - VIEWPORT_GUTTER)
    }
    if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER
    btn.style.left = `${left}px`
    if (showAbove) {
        btn.style.bottom = `${vh - anchor.top + ANCHOR_GAP}px`
        btn.style.top = 'auto'
    } else {
        btn.style.top = `${anchor.bottom + ANCHOR_GAP}px`
        btn.style.bottom = 'auto'
    }
}
