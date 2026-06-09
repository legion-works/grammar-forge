// Per-field lifecycle owner (original to GrammarForge). Encapsulates the listeners (input/blur) + the
// per-field debouncer + the (separately-rendered) overlay handle hooks for a
// single editable element. Returned `detach()` is idempotent and releases
// EVERYTHING bound to this field, so a chatty SPA removing+re-inserting
// editors doesn't leak listeners or skew the popup field count.
//
// Key invariants:
//   - listeners are added on attach and removed on detach
//   - the debouncedRun reads `el` at FIRE time, not at call time, so rapid
//     keystrokes coalesce and the text the bridge sees is the LATEST
//     value (Fix 2)
//   - detach() decrements the shared fieldCount exactly once, even on
//     repeated calls
//   - detach() destroys any overlay handles that were registered via
//     setHandles() so the DOM is cleaned up even if the content script
//     hasn't yet been able to re-render

import { createDebouncer } from '@/input/debounce'
import { getText } from '@/input/text'

export interface FieldHandles {
    /** Called once on detach. Omitted when the highlight is not rendered. */
    highlightDestroy?: () => void
    /** Called once on detach. Omitted when no popover is open. */
    popoverHide?: () => void
    /** Called once on detach. Omitted when the status pill is not rendered. */
    statusDestroy?: () => void
}

export interface FieldAttachmentOptions {
    /** Trailing-edge debounce window in ms (mirrors settings.realtimeDelayMs). */
    realtimeDelayMs: number
    /**
     * Async check runner. The attachment reads the field text at FIRE time
     * and passes the live text + the element (so the caller can re-resolve
     * text against the live DOM if it needs to). The caller is responsible
     * for not running a check against a field that has been detached.
     */
    onRunCheck: (el: HTMLElement, text: string) => Promise<void> | void
    /** Synchronous blur callback (e.g. flush pending signals). */
    onBlur: () => void
    /**
     * Optional gate consulted on EVERY `input` event before a debounced check
     * is scheduled. Receives the event's `inputType` ('' when unavailable) and
     * returns whether to schedule the check. This is the SINGLE place the input
     * policy lives — the orchestrator implements realtime-mode / paste-skip /
     * paste-grace here (and may perform side effects such as arming a grace
     * timer). When omitted, every input event schedules a check (legacy
     * behaviour). NOTE: this is now the only `input` listener on the field —
     * the orchestrator no longer installs a separate capture-phase gate, so
     * this gate is authoritative (previously a duplicate listener scheduled a
     * check regardless of the gate, silently breaking paste-skip / ondemand).
     */
    onInputEvent?: (inputType: string) => boolean
}

/** Reads the current count of fields in the caller's registry. */
export type FieldCountReader = () => number
/** Atomically decrements the caller's field count by 1. */
export type FieldCountDecrement = () => void

export interface FieldAttachment {
    /** Schedule a check (debounced). Reads `el` at fire time. */
    debouncedRun: () => void
    /**
     * Cancel any pending debounced check without detaching. Used by the
     * orchestrator when arming a paste-grace window so a debounce scheduled by
     * typing just before the paste does not fire during the grace.
     */
    cancelPending: () => void
    /** Run a check immediately (e.g. on-demand TRIGGER_CHECK, post-accept). */
    rerun: (text: string) => void
    /** Register/refresh the overlay handles the field currently owns. */
    setHandles: (handles: FieldHandles) => void
    /**
     * Tear down the CURRENT handles in place (highlight + popover + status)
     * WITHOUT detaching the field. Used when the field has left the DOM mid-
     * check (its overlay must be cleared even though the attachment lives on
     * until the observer's detach fires). Unlike a `setHandles` re-render swap
     * — which preserves the persistent highlight so a fresh render isn't wiped
     * — this clears everything, including the highlight.
     */
    clearHandles: () => void
    /** Release everything bound to this field. Idempotent. */
    detach: () => void
    /** Whether detach() has been called. */
    isDetached: () => boolean
}

/**
 * Attach the per-field input + blur listeners + debouncer to `el`. The
 * `countReader` and `countDecrement` callbacks let the caller keep a
 * shared counter in sync (the content script's `runtime.fieldCount`).
 * The attachment itself doesn't store the count — it queries/mutates via
 * the supplied callbacks so the content script stays the single source of
 * truth.
 */
export function createFieldAttachment(
    el: HTMLElement,
    options: FieldAttachmentOptions,
    countReader: FieldCountReader,
    countDecrement: FieldCountDecrement,
): FieldAttachment {
    let detached = false
    let handles: FieldHandles = {}

    const onInput = (e: Event): void => {
        if (detached) return
        if (options.onInputEvent) {
            // The orchestrator's gate decides (realtime-mode / paste-skip /
            // paste-grace) and may arm a grace timer as a side effect. When it
            // returns false we schedule nothing — this is the authoritative
            // input gate (there is no longer a duplicate capture-phase listener).
            const inputType = (e as InputEvent).inputType ?? ''
            if (!options.onInputEvent(inputType)) return
        }
        debouncedRun()
    }
    const onBlur = (): void => {
        if (detached) return
        options.onBlur()
    }

    const debouncedRun = createDebouncer<[]>(() => {
        // The check runs at fire time, not at keystroke time — read the
        // element's text here so a typing burst coalesces into a single
        // check against the LATEST value (Fix 2).
        void options.onRunCheck(el, getText(el))
    }, options.realtimeDelayMs)

    const rerun = (text: string): void => {
        void options.onRunCheck(el, text)
    }

    el.addEventListener('input', onInput)
    el.addEventListener('blur', onBlur)

    // Run the TRANSIENT destroy hooks (status pill + popover) of a handle set.
    // These are re-created fresh on every render (renderStatusButton already
    // removes the prior pill via destroyExisting; the popover is per-open), so
    // tearing the old ones down on a swap is safe + idempotent.
    const runTransientDestroyers = (h: FieldHandles): void => {
        try {
            h.popoverHide?.()
        } catch {
            // ignore
        }
        try {
            h.statusDestroy?.()
        } catch {
            // ignore
        }
    }

    // Run the PERSISTENT highlight destroyer. The highlight layer (overlay
    // reconciling pool) and the native CSS-Custom-Highlight registry entries
    // are UPDATED IN PLACE on each render (reconcile / setFieldHighlights), not
    // destroyed+recreated — so this must run ONLY on detach / field-gone, never
    // on a per-render swap. Running it on a swap was the "highlights die on the
    // first edit" bug: the new render set the ranges, then the prior render's
    // highlightDestroy=clearField wiped them.
    const runHighlightDestroyer = (h: FieldHandles): void => {
        try {
            h.highlightDestroy?.()
        } catch {
            // page returning to unmonitored state; ignore
        }
    }

    const setHandles = (next: FieldHandles): void => {
        if (detached) return
        // Tear down only the PREVIOUS render's TRANSIENT overlay (pill +
        // popover) before adopting the new handles — the swap stays atomic for
        // those. The highlight is persistent (updated in place by the new
        // render), so its destroyer is carried forward, NOT run here; running
        // it would wipe the highlights the new render just set.
        runTransientDestroyers(handles)
        // Carry forward a highlightDestroy when the caller didn't supply a new
        // one, so detach can still clear the persistent highlight. renderField
        // always supplies one (pointing at the same persistent layer/field), so
        // in practice this just replaces like-for-like.
        handles = {
            ...next,
            highlightDestroy: next.highlightDestroy ?? handles.highlightDestroy,
        }
    }

    const clearHandles = (): void => {
        if (detached) return
        // Field gone (left the DOM mid-check): clear EVERYTHING, including the
        // persistent highlight, then drop the handles. Distinct from a re-
        // render swap, which preserves the highlight.
        runTransientDestroyers(handles)
        runHighlightDestroyer(handles)
        handles = {}
    }

    const detach = (): void => {
        if (detached) return
        detached = true
        el.removeEventListener('input', onInput)
        el.removeEventListener('blur', onBlur)
        debouncedRun.cancel()
        // Destroy whatever overlay handles are currently bound — transient
        // (pill/popover) AND the persistent highlight. The popover may be
        // mid-open; popoverHide() is idempotent.
        runTransientDestroyers(handles)
        runHighlightDestroyer(handles)
        // Decrement exactly once: the countReader is called BEFORE the
        // decrement so the caller can decide to no-op (e.g. if the runtime
        // was already torn down). We never decrement when the count is
        // already 0 — that would corrupt the popup reading.
        if (countReader() > 0) countDecrement()
    }

    return {
        debouncedRun,
        cancelPending: () => debouncedRun.cancel(),
        rerun,
        setHandles,
        clearHandles,
        detach,
        isDetached: () => detached,
    }
}
