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
    /** Called once on detach. Omitted when the underline is not rendered. */
    underlineDestroy?: () => void
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
}

/** Reads the current count of fields in the caller's registry. */
export type FieldCountReader = () => number
/** Atomically decrements the caller's field count by 1. */
export type FieldCountDecrement = () => void

export interface FieldAttachment {
    /** Schedule a check (debounced). Reads `el` at fire time. */
    debouncedRun: () => void
    /** Run a check immediately (e.g. on-demand TRIGGER_CHECK, post-accept). */
    rerun: (text: string) => void
    /** Register/refresh the overlay handles the field currently owns. */
    setHandles: (handles: FieldHandles) => void
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

    const onInput = (): void => {
        if (detached) return
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

    const setHandles = (next: FieldHandles): void => {
        if (detached) return
        handles = next
    }

    const detach = (): void => {
        if (detached) return
        detached = true
        el.removeEventListener('input', onInput)
        el.removeEventListener('blur', onBlur)
        debouncedRun.cancel()
        // Destroy whatever overlay handles are currently bound. The
        // popover may be mid-open; popoverHide() is idempotent (the popover
        // handle's hide() returns immediately when there's nothing to
        // close).
        try {
            handles.underlineDestroy?.()
        } catch {
            // A single failed destroy must not block the rest of the
            // cleanup — the page is going back to its unmonitored state.
        }
        try {
            handles.popoverHide?.()
        } catch {
            // see above
        }
        try {
            handles.statusDestroy?.()
        } catch {
            // see above
        }
        // Decrement exactly once: the countReader is called BEFORE the
        // decrement so the caller can decide to no-op (e.g. if the runtime
        // was already torn down). We never decrement when the count is
        // already 0 — that would corrupt the popup reading.
        if (countReader() > 0) countDecrement()
    }

    return {
        debouncedRun,
        rerun,
        setHandles,
        detach,
        isDetached: () => detached,
    }
}
