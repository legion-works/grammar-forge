// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// Trailing-edge debounce. Coalesces rapid calls (keystrokes) into a single
// trailing invocation with the latest args. The textchecker's per-field
// debouncer runs an idle callback per text field; this version is a small
// reusable helper that exposes cancel() and flush() (the latter used by
// blur/navigation handlers to fire any pending check immediately).

/**
 * Create a trailing-edge debouncer. Calls are coalesced within `waitMs`;
 * only the latest call's args reach `fn`. `cancel()` drops a pending call;
 * `flush()` fires it now. `flush()` is a no-op when nothing is pending.
 */
export function createDebouncer<A extends unknown[]>(
    fn: (...args: A) => void,
    waitMs: number,
): {
    (...args: A): void
    cancel(): void
    flush(): void
} {
    let timer: ReturnType<typeof setTimeout> | null = null
    let pendingArgs: A | null = null

    const run = (): void => {
        timer = null
        const args = pendingArgs
        pendingArgs = null
        if (args) fn(...args)
    }

    const debounced = (...args: A): void => {
        pendingArgs = args
        if (timer != null) clearTimeout(timer)
        timer = setTimeout(run, waitMs)
    }

    debounced.cancel = (): void => {
        if (timer != null) {
            clearTimeout(timer)
            timer = null
        }
        pendingArgs = null
    }

    debounced.flush = (): void => {
        if (timer == null) return
        clearTimeout(timer)
        run()
    }

    return debounced
}
