// Thin public re-export of the shared debug-log core. The actual write
// is delegated to a DebugBackend (see ./debug-backends). This module
// stays as the SINGLE place `console` is touched on the overlay hot
// path, so the oxlint `no-console` disable lives here only; call
// sites stay clean.
//
// Defaults: Console backend with `[gf]` prefix, gated on the
// `localStorage.gfDebug` flag (read fresh on every call so toggling
// takes effect immediately, no reload needed). The `override` knob
// is for tests; production leaves it null.

import { createConsoleBackend, createLocalStorageOverrideBackend } from './debug-backends'

const STORAGE_KEY = 'gfDebug'

/** Test-only override: when non-null it wins over the localStorage flag, so the
 *  vitest suite can force logging on/off deterministically. */
let override: boolean | null = null

const inner = createConsoleBackend({ prefix: '[gf]' })
const backend = createLocalStorageOverrideBackend({ storageKey: STORAGE_KEY, inner })

export function setDebugLoggingEnabled(value: boolean | null): void {
    override = value
}

export function isDebugLoggingEnabled(): boolean {
    return override ?? backend.enabled()
}

export function debugLog(scope: string, message: string, data?: unknown): void {
    if (!isDebugLoggingEnabled()) return
    backend.log('info', scope, message, data)
}

export function debugWarn(scope: string, message: string, data?: unknown): void {
    // debugWarn bypasses the enable flag — a failed bridge call should
    // always be visible to the maintainer, regardless of the debug toggle.
    backend.log('warn', scope, message, data)
}
