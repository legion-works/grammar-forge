// W1-5 re-skin: transient bottom-of-overlay toast with a leading category/
// action icon, a two-line body (primary + sub), and a soft Undo button.
// Auto-dismisses after `durationMs`; the button cancels the timer and
// fires onUndo. onDismiss fires once per toast — on auto-dismiss, manual
// dismiss(), or replacement. onAction is retained as a back-compat alias
// for onUndo; onUndo wins when both are supplied.
export interface ToastOptions {
    /** Primary line of text (required). */
    message: string
    /** Optional second line (e.g. "Grammar rule \u00b7 signal sent"). */
    subText?: string
    /** Optional leading emoji (e.g. "\u2728", "\u2713", "\ud83d\udcd6"). */
    icon?: string
    /** Action button text. Defaults to "Undo" when omitted. */
    actionLabel?: string
    /** Called when the user clicks the action button. Cancels auto-dismiss. */
    onUndo?: () => void
    /** DEPRECATED alias for onUndo. Kept for callers that haven't migrated
     *  to the new name; ignored when onUndo is also supplied. */
    onAction?: () => void
    /** Called once per toast lifecycle: auto-dismiss, manual dismiss(), or
     *  the toast being replaced. NOT called when the user clicks Undo (the
     *  orchestrator is the one that decides what to do post-Undo). */
    onDismiss?: () => void
    /** Default 1200ms. */
    durationMs?: number
}

export interface ToastHandle {
    dismiss: () => void
}

// Placement audit (TOASTS): one toast per root, but the previous
// implementation replaced a still-showing toast with a blunt
// `querySelectorAll('.gf-toast').forEach(n => n.remove())` DOM sweep — that
// removes the node WITHOUT going through the old toast's own `dismiss()`,
// so its auto-dismiss `setTimeout` kept running in the background and its
// `onDismiss` (when a caller supplies one) fired later, un-cancelled,
// against a toast the user never saw close. Several mutation toasts firing
// in quick succession (accept-all, then an immediate undo, etc.) could
// leave multiple orphaned timers ticking. Track the single active handle
// per root and call ITS `dismiss()` before creating the next one, so the
// previous toast's timer is cancelled and its lifecycle-once `onDismiss`
// (if any) fires deterministically at replacement time, not later.
const ACTIVE = new WeakMap<ShadowRoot, ToastHandle>()

export function showToast(root: ShadowRoot, opts: ToastOptions): ToastHandle {
    ACTIVE.get(root)?.dismiss()
    const doc = root.ownerDocument
    const el = doc.createElement('div')
    el.className = 'gf-toast'
    el.setAttribute('role', 'status')
    el.setAttribute('aria-live', 'polite')

    if (opts.icon) {
        const icon = doc.createElement('span')
        icon.className = 'gf-toast__icon'
        icon.setAttribute('aria-hidden', 'true')
        icon.textContent = opts.icon
        el.appendChild(icon)
    }

    const body = doc.createElement('div')
    body.className = 'gf-toast__body'
    const text = doc.createElement('div')
    text.className = 'gf-toast__text'
    text.textContent = opts.message
    body.appendChild(text)
    if (opts.subText) {
        const sub = doc.createElement('div')
        sub.className = 'gf-toast__sub'
        sub.textContent = opts.subText
        body.appendChild(sub)
    }
    el.appendChild(body)

    const btn = doc.createElement('button')
    btn.type = 'button'
    // W1-5: the design-system class is `.gf-btn-soft` (the old
    // `.gf-toast__action` is gone). Same visual hierarchy as the soft
    // dismiss button on the correction card.
    btn.className = 'gf-btn-soft'
    btn.textContent = opts.actionLabel ?? 'Undo'
    el.appendChild(btn)

    // Use the global setTimeout/clearTimeout (not view.setTimeout) so the
    // return type matches the codebase-wide `ReturnType<typeof setTimeout>`
    // convention; in a real browser the global is window.setTimeout anyway,
    // so it routes to the same timer queue.
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(
        () => dismiss(),
        opts.durationMs ?? 1200,
    )

    // Shared teardown: cancel the timer, remove the node, and release this
    // toast's ACTIVE-registry slot (but only if it's STILL this toast's
    // handle — a newer showToast() on the same root already replaced the
    // entry before this one's dismiss() could run, so don't clobber it).
    const teardown = (): void => {
        if (timer != null) {
            clearTimeout(timer)
            timer = null
        }
        if (el.isConnected) el.remove()
        if (ACTIVE.get(root) === handle) ACTIVE.delete(root)
    }

    let dismissed = false
    function dismiss(): void {
        if (dismissed) return
        dismissed = true
        teardown()
        // Fire onDismiss exactly once per toast lifecycle. The Undo branch
        // skips this so the orchestrator's "show on every mutation +
        // dismiss → signal(rejected)" wiring (W3) can decide what to do
        // post-Undo without us double-reporting.
        opts.onDismiss?.()
    }

    btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (dismissed) return
        dismissed = true
        // Cancel the auto-dismiss timer without firing onDismiss — the
        // Undo button IS the user's exit; onDismiss is for natural fade-outs.
        teardown()
        // onUndo wins over onAction when both are passed.
        if (opts.onUndo) opts.onUndo()
        else if (opts.onAction) opts.onAction()
    })

    const handle: ToastHandle = { dismiss }
    ACTIVE.set(root, handle)
    root.appendChild(el)
    return handle
}
