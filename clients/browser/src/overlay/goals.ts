// The W2b Goals popover — the audience/formality/domain editor opened
// from the panel's Goals pill. One per shadow root (the orchestrator
// dismisses the prior on a new showGoals).
//
// Behaviour (per flows.md §7 + reference DC §6):
//   - Segmented controls: audience (general / informed / expert) +
//     formality (informal / neutral / formal) — three options each.
//   - On change → onChange(next) is fired with the new Goals; the
//     orchestrator persists it to settings and re-renders the panel
//     (the muted-style filter + the default rephrase tone are computed
//     in view-model from the new Goals; this module just edits the
//     object + notifies — see panel-model.ts + view-model.ts).
//   - A faint hint explains the side-effect of formality: "Informal
//     mutes style nudges; formal raises the bar."
//   - Esc + outside-click dismiss. The orchestrator owns the teardown
//     lifecycle; this module exposes `destroy()`.
//
// Surface invariants (per the W2b spec):
//   - Caller-measured `anchorRect` — never self-measure. The orchestrator
//     measures the panel's Goals pill rect before mounting.
//   - `opacity: 1` default + transform-only entrance (scale-in from
//     the pill's top). `transform-origin: 50% 0%`.

import type { Goals } from '@/api/types'
import {
    installEscapeCapture,
    installOutsideDismiss,
    type EscapeCaptureHandle,
    type OutsideDismissHandle,
} from '@/overlay/dismiss'

const VIEWPORT_GUTTER = 8
const POPOVER_WIDTH = 300
const POPOVER_HEIGHT_FALLBACK = 200

export interface GoalsOptions {
    /** Viewport rect the popover anchors to (the panel's Goals pill, or
     *  the orb when the popover is opened from another surface). */
    anchorRect: DOMRect
    /** Current goals — drives which segmented option shows as active. */
    goals: Goals
    /** Called on every seg click with the new Goals. The caller (the
     *  orchestrator) persists it to settings and re-renders the panel
     *  with the updated visible() filter + the muted note + the rephrase
     *  default tone. */
    onChange: (next: Goals) => void
    /** Called on Esc / outside-click. The caller calls `destroy()`. */
    onClose: () => void
}

export interface GoalsHandle {
    destroy: () => void
    isOpen: () => boolean
}

const AUDIENCE_OPTIONS: ReadonlyArray<{ value: Goals['audience']; label: string }> = [
    { value: 'general', label: 'General' },
    { value: 'informed', label: 'Informed' },
    { value: 'expert', label: 'Expert' },
]

const FORMALITY_OPTIONS: ReadonlyArray<{ value: Goals['formality']; label: string }> = [
    { value: 'informal', label: 'Informal' },
    { value: 'neutral', label: 'Neutral' },
    { value: 'formal', label: 'Formal' },
]

/**
 * Mount the Goals popover in the supplied shadow root, anchored to the
 * supplied rect. Replaces any prior Goals popover (only one at a time
 * per root). Returns a handle whose `destroy()` removes the popover and
 * its listeners.
 */
export function showGoals(root: ShadowRoot, options: GoalsOptions): GoalsHandle {
    destroyExisting(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    // P1-5: capture whatever had focus before the popover opened so every
    // close path can restore it (see popover.ts for the full rationale).
    const previouslyFocused = doc.activeElement instanceof HTMLElement ? doc.activeElement : null

    const pop = doc.createElement('div')
    pop.className = 'gf-goals-pop'
    pop.setAttribute('role', 'dialog')
    pop.setAttribute('aria-label', 'Goals')

    // Head
    const head = el(pop, 'div', 'gf-goals__head')
    head.textContent = '\u25CE Goals'
    const faint = el(head, 'span', 'gf-goals__faint')
    faint.textContent = 'tunes what surfaces'

    // Audience row
    const audRow = el(pop, 'div', 'gf-goals__row')
    el(audRow, 'span', 'gf-goals__label').textContent = 'Audience'
    renderSegGroup(audRow, AUDIENCE_OPTIONS, options.goals.audience, (value) => {
        options.onChange({ ...options.goals, audience: value })
    })

    // Formality row
    const formRow = el(pop, 'div', 'gf-goals__row')
    el(formRow, 'span', 'gf-goals__label').textContent = 'Formality'
    renderSegGroup(formRow, FORMALITY_OPTIONS, options.goals.formality, (value) => {
        options.onChange({ ...options.goals, formality: value })
    })

    // Side-effect note
    const note = el(pop, 'p', 'gf-goals__note')
    note.textContent = 'Informal mutes style nudges; formal raises the bar.'

    root.appendChild(pop)
    positionPopover(pop, options.anchorRect, view)

    // Esc dismiss — window capture (P1-7), same fix as the outside-click
    // dismiss below: a document-bubble listener never fires on hosts that
    // stopPropagation at window capture.
    const escapeCapture: EscapeCaptureHandle = installEscapeCapture(view, () => options.onClose(), 'goals')

    // Outside-click (light-dismiss) via the unified dismiss helper.
    // Uses window capture so host-page stopPropagation can't block it.
    const outsideDismiss: OutsideDismissHandle = installOutsideDismiss(
        view,
        (el) => pop.contains(el) || el === pop,
        () => options.onClose(),
        'goals',
    )

    const handle: GoalsHandle = {
        destroy: () => {
            outsideDismiss.remove()
            escapeCapture.remove()
            if (pop.isConnected) pop.remove()
            // P1-5: restore focus to whatever had it before this popover
            // opened, on EVERY close path (destroy() is the single funnel
            // for Esc, outside-dismiss, and programmatic teardown alike).
            if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus()
            unregisterGoals(root, handle)
        },
        isOpen: () => pop.isConnected,
    }
    registerGoals(root, handle)

    return handle
}

// Per-root registry: mirror of popover.ts / rephrase-card.ts's REGISTRY
// pattern. destroyExisting() used to only querySelectorAll(...).remove()
// the prior popover's DOM, never calling its destroy() — which left the
// prior instance's installOutsideDismiss (window-capture pointerdown) and
// installEscapeCapture (window-capture keydown) listeners, plus its
// focus-restore, all orphaned on every re-open.
const REGISTRY = new WeakMap<ShadowRoot, Set<GoalsHandle>>()

function registerGoals(root: ShadowRoot, handle: GoalsHandle): void {
    let set = REGISTRY.get(root)
    if (!set) {
        set = new Set()
        REGISTRY.set(root, set)
    }
    set.add(handle)
}

function unregisterGoals(root: ShadowRoot, handle: GoalsHandle): void {
    const set = REGISTRY.get(root)
    if (!set) return
    set.delete(handle)
    if (set.size === 0) REGISTRY.delete(root)
}

/** Destroy every Goals popover currently mounted in `root` via the real
 *  `destroy()` (releasing its listeners + restoring focus), not just its
 *  DOM. Exported for the shadow host's teardown, mirroring
 *  dismissPopoversIn / dismissRephraseCardsIn. */
export function dismissGoalsIn(root: ShadowRoot): void {
    const set = REGISTRY.get(root)
    if (!set) return
    // copy to a fresh array: destroy() mutates the set (unregisters itself)
    for (const handle of Array.from(set)) handle.destroy()
}

function destroyExisting(root: ShadowRoot): void {
    dismissGoalsIn(root)
    // Defensive sweep for any .gf-goals-pop node not tracked by the
    // registry (should not happen — showGoals always registers — but
    // avoids a doubled popover if some future caller ever bypasses the
    // handle bookkeeping).
    root.querySelectorAll('.gf-goals-pop').forEach((el) => el.remove())
}

function renderSegGroup<T extends string>(
    parent: HTMLElement,
    options: ReadonlyArray<{ value: T; label: string }>,
    active: T,
    onPick: (value: T) => void,
): void {
    const group = el(parent, 'div', 'gf-seg-group')
    group.setAttribute('role', 'radiogroup')
    for (const opt of options) {
        const btn = el(group, 'button', 'gf-seg') as HTMLButtonElement
        btn.type = 'button'
        btn.setAttribute('role', 'radio')
        btn.setAttribute('aria-checked', String(opt.value === active))
        if (opt.value === active) btn.classList.add('is-active')
        btn.textContent = opt.label
        btn.addEventListener('mousedown', (e) => e.preventDefault())
        btn.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            if (opt.value === active) return
            // Update the visual active state immediately; onChange may
            // dismiss + re-render, so the next render refreshes anyway.
            for (const sib of group.querySelectorAll<HTMLElement>('.gf-seg')) {
                sib.classList.toggle('is-active', sib === btn)
                sib.setAttribute('aria-checked', String(sib === btn))
            }
            onPick(opt.value)
        })
    }
}

function el(parent: Node, tag: string, className?: string): HTMLElement {
    const node = document.createElement(tag)
    if (className) node.className = className
    parent.appendChild(node)
    return node
}

function positionPopover(pop: HTMLElement, anchor: DOMRect, view: Window): void {
    const vw = view.innerWidth
    const vh = view.innerHeight
    const width = pop.offsetWidth || POPOVER_WIDTH
    const height = pop.offsetHeight || POPOVER_HEIGHT_FALLBACK
    // Default: popover sits BELOW the pill, right-aligned. Flip above if
    // no room below.
    let left = anchor.right - width
    if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER
    if (left + width > vw - VIEWPORT_GUTTER) left = vw - width - VIEWPORT_GUTTER
    let top = anchor.bottom + 6
    if (top + height > vh - VIEWPORT_GUTTER) top = anchor.top - height - 6
    if (top < VIEWPORT_GUTTER) top = VIEWPORT_GUTTER
    pop.style.left = `${String(left)}px`
    pop.style.top = `${String(top)}px`
}
