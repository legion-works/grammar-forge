// Transient bottom-of-overlay toast with one action (e.g. Undo). Auto-dismisses
// after `durationMs`; the action button cancels the timer and fires onAction.
export interface ToastHandle {
    dismiss: () => void
}
export function showToast(
    root: ShadowRoot,
    opts: {
        message: string
        actionLabel: string
        onAction: () => void
        durationMs?: number
    },
): ToastHandle {
    root.querySelectorAll('.gf-toast').forEach((n) => n.remove())
    const el = root.ownerDocument.createElement('div')
    el.className = 'gf-toast'
    el.setAttribute('role', 'status')
    const msg = root.ownerDocument.createElement('span')
    msg.textContent = opts.message
    const btn = root.ownerDocument.createElement('button')
    btn.type = 'button'
    btn.className = 'gf-toast__action'
    btn.textContent = opts.actionLabel
    el.append(msg, btn)
    root.appendChild(el)
    // Use the global setTimeout/clearTimeout (not view.setTimeout) so the
    // return type matches the codebase-wide `ReturnType<typeof setTimeout>`
    // convention; in a real browser the global is window.setTimeout anyway,
    // so it routes to the same timer queue.
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(
        () => dismiss(),
        opts.durationMs ?? 1200,
    )
    function dismiss(): void {
        if (timer != null) {
            clearTimeout(timer)
            timer = null
        }
        if (el.isConnected) el.remove()
    }
    btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        dismiss()
        opts.onAction()
    })
    return { dismiss }
}
