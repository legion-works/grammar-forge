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

    // Esc dismiss
    const onKeydown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            event.stopPropagation()
            options.onClose()
        }
    }
    // Outside-click dismiss — delayed to ignore the same click that opened
    // the popover. Composed-path aware (shadow-DOM safe).
    let outsideClickArmed = false
    const onOutsideMouseDown = (event: MouseEvent): void => {
        if (!outsideClickArmed) return
        const path = event.composedPath()
        if (path.includes(pop)) return
        options.onClose()
    }
    document.addEventListener('keydown', onKeydown)
    document.addEventListener('mousedown', onOutsideMouseDown, true)
    // Arm the outside-click after the current click tick settles.
    const armTimer = view.setTimeout(() => {
        outsideClickArmed = true
    }, 0)

    return {
        destroy: () => {
            view.clearTimeout(armTimer)
            document.removeEventListener('keydown', onKeydown)
            document.removeEventListener('mousedown', onOutsideMouseDown, true)
            if (pop.isConnected) pop.remove()
        },
        isOpen: () => pop.isConnected,
    }
}

function destroyExisting(root: ShadowRoot): void {
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
