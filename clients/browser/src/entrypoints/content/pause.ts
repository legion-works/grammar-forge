// Paused-site minimal runtime: when the user disables the extension on
// the current hostname (via the pill's Power button, or the popup
// blockedSites deny-list), the content script falls back to a minimal
// field-discovery + focus-tracking runtime that surfaces a "re-enable"
// pill anchored to the focused composer. No bridge, no checking, no
// highlights.
//
// The pure decision (given a settings snapshot and the current mode,
// what should happen next) is exported as `nextPauseMode` for tests.
// `mountPausedMode` is the IO-laden lifecycle that does the work.

import { createFieldObserver } from '@/input/observer'
import { createOverlayHost } from '@/overlay/shadow-host'
import { renderStatusButton, type StatusButtonHandle } from '@/overlay/status-button'
import { isSiteBlocked, type Settings } from '@/storage/settings'

export type PauseMode = 'off' | 'site-paused' | 'active'

export interface PauseDecision {
    mode: PauseMode
}

/** Pure: given a settings snapshot, the current mode, and the current
 *  hostname, decide what mode to be in next. The orchestrator's reconcile()
 *  loop calls this on every settings change and mounts/unmounts the paused
 *  runtime accordingly. */
export function nextPauseMode(s: Settings, current: PauseMode, hostname: string): PauseDecision {
    if (!s.enabled) return { mode: 'off' }
    if (isSiteBlocked(s, hostname)) return { mode: 'site-paused' }
    if (current === 'site-paused') return { mode: 'active' }
    return { mode: current }
}

export interface PauseModeDeps {
    hostname: string
    getLastFocusedField: () => HTMLElement | null
    setLastFocusedField: (el: HTMLElement | null) => void
    getDragOffset: () => { dx: number; dy: number } | undefined
    setDragOffset: (offset: { dx: number; dy: number } | undefined) => void
    /** The orchestrator's Power-button handler. The paused pill's
     *  onTogglePower invokes it; the persist-then-reconcile loop takes
     *  care of unmounting us on the next settings tick. */
    onTogglePower: () => void | Promise<void>
}

export function mountPausedMode(deps: PauseModeDeps): { stop: () => void } {
    const cleanups: Array<() => void> = []
    const host = createOverlayHost()
    cleanups.push(() => host.destroy())
    const fields = new Set<HTMLElement>()
    let pillHandle: StatusButtonHandle | null = null
    let pillFor: HTMLElement | null = null
    const hidePill = (): void => {
        pillHandle?.destroy()
        pillHandle = null
        pillFor = null
    }
    const showPillFor = (el: HTMLElement): void => {
        hidePill()
        pillFor = el
        pillHandle = renderStatusButton(host.root, {
            count: 0,
            anchorRect: el.getBoundingClientRect(),
            disabled: true,
            corrections: [],
            onFocusField: () => el.focus(),
            onTogglePower: () => void deps.onTogglePower(),
            onRecheck: () => {},
            onApplyAll: () => {},
            onApplyOne: () => {},
            onUndo: () => {},
            onRephrase: () => {},
            undoAvailable: false,
            dragOffset: deps.getDragOffset() ?? undefined,
            onDragMove: (offset) => deps.setDragOffset(offset),
        })
    }
    const stopObserver = createFieldObserver({
        root: document.body,
        onFieldDiscovered: (el) => {
            fields.add(el)
            if (el.contains(document.activeElement)) showPillFor(el)
        },
        onFieldDetached: (el) => {
            fields.delete(el)
            if (deps.getLastFocusedField() === el) deps.setLastFocusedField(null)
            if (pillFor === el) hidePill()
        },
    })
    // Seed the pill for the field the user was last editing. The field
    // observer's initial sweep is deferred (rAF) and gated on
    // document.activeElement, which is <body> right after the Power button
    // that triggered the disable was destroyed — so without this seed no
    // pill (hence no in-page Enable affordance) would appear until the user
    // re-focuses a field. showPillFor only needs the element; the observer
    // adds it to `fields` on its next tick (showPillFor is idempotent).
    const last = deps.getLastFocusedField()
    if (last?.isConnected) showPillFor(last)
    cleanups.push(stopObserver)
    const onFocusIn = (e: FocusEvent): void => {
        const t = e.target
        if (!(t instanceof HTMLElement)) return
        for (const f of fields) {
            if (f === t || f.contains(t)) {
                showPillFor(f)
                return
            }
        }
    }
    const onFocusOut = (): void => {
        // Defer: focus may be moving INTO the pill (drag) or to a child.
        setTimeout(() => {
            if (pillFor && !pillFor.contains(document.activeElement)) hidePill()
        }, 0)
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    cleanups.push(() => {
        document.removeEventListener('focusin', onFocusIn)
        document.removeEventListener('focusout', onFocusOut)
    })
    const reposition = (): void => {
        if (pillFor && pillHandle) pillHandle.reposition(pillFor.getBoundingClientRect())
    }
    document.addEventListener('scroll', reposition, { capture: true, passive: true })
    window.addEventListener('resize', reposition, { passive: true })
    cleanups.push(() => {
        document.removeEventListener('scroll', reposition)
        window.removeEventListener('resize', reposition)
    })
    cleanups.push(hidePill)

    return {
        stop: () => {
            for (const c of cleanups) {
                try {
                    c()
                } catch {
                    /* teardown is best-effort */
                }
            }
        },
    }
}
