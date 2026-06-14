// Vencord debug-log wrapper around the shared Console backend. The
// `[GrammarForge +Xms]` relative-time prefix (X = ms since orchestrator
// start) is computed PER CALL so event ORDER and LATENCY show up in
// async-apply traces — the static prefix of the shared Console backend
// can't carry that. Gated on the plugin's `debugLogging` setting (the
// Discord renderer has no `localStorage`).
//
// Keeps the OLD variadic shape — vencord's call sites pass arbitrary
// positional args (scope, message, data, and the variadic tail in
// some places), so the wrapper mirrors that. Underneath it forwards
// the (scope, message) pair to the shared backend.

import { createConsoleBackend } from '@/lib/debug-backends'

let startMs = 0
let isEnabled: () => boolean = () => false

export function configureVencordDebug(opts: { startMs: number; isEnabled: () => boolean }): void {
    startMs = opts.startMs
    isEnabled = opts.isEnabled
}

const backend = createConsoleBackend({
    prefix: '[GrammarForge]',
    isEnabled: () => isEnabled(),
})

/** Variadic: matches the previous inline impl's `(scope, message, ...args)`.
 *  We map positional args to the shared `(scope, message, data?)` shape. */
export function debugLog(...args: unknown[]): void {
    if (!isEnabled()) return
    const t = (performance.now() - startMs).toFixed(1)
    const scope = typeof args[0] === 'string' ? args[0] : ''
    const message = typeof args[1] === 'string' ? args[1] : ''
    const data = args.length > 2 ? args[2] : undefined
    // The Console backend's prefix is static, so we re-emit with the
    // timestamp embedded. Same line shape as the original inline impl.
    const line = `+${t}ms ${scope}: ${message}`
    if (data === undefined) backend.log('info', '', line)
    else backend.log('info', '', line, data)
}
