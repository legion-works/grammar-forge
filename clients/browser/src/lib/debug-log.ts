// Gated debug logger for the content-script overlay lifecycle (highlight +
// pill rendering, field attach/detach, scroll remeasure). OFF by default so a
// production install is silent — privacy invariant #1 means we never emit
// telemetry, and a public install shouldn't spam the page console.
//
// Turn it on from the page console (no reload needed — the flag is read fresh
// on every call; the log sites are low-frequency render/attach/detach paths,
// not per-frame):
//   localStorage.gfDebug = '1'      // enable
//   delete localStorage.gfDebug     // disable
//
// IMPORTANT: we log at the `console.log` (Info) level, NOT `console.debug`.
// `console.debug` maps to the DevTools "Verbose" level, which is HIDDEN unless
// you tick Verbose in the console's level dropdown — so debug lines silently
// vanished. `console.log` shows at the default Info level. A namespaced prefix
// ('[gf]') keeps the lines filterable.
//
// This is the SINGLE place `console` is touched on the overlay hot path, so
// the oxlint `no-console` disable lives here only; call sites stay clean.

const PREFIX = '[gf]'

/**
 * Test-only override: when non-null it wins over the localStorage flag, so the
 * vitest suite can force logging on/off deterministically. Production leaves it
 * null and reads `localStorage.gfDebug` fresh on every call.
 */
let override: boolean | null = null

/**
 * Read `localStorage.gfDebug` fresh (any value other than ''/'0'/absent
 * enables). Guarded in a try/catch because some sandboxed pages throw on
 * `localStorage` access. Reading per-call (rather than caching at module init)
 * means toggling the flag takes effect immediately — no page reload required.
 */
function readLocalStorageFlag(): boolean {
    try {
        if (typeof localStorage === 'undefined') return false
        const v = localStorage.getItem('gfDebug')
        return v != null && v !== '' && v !== '0'
    } catch {
        return false
    }
}

/** Whether debug logging is currently on (override wins; else localStorage). */
function enabled(): boolean {
    return override ?? readLocalStorageFlag()
}

/**
 * Force/clear the enabled state. Pass a boolean to pin it (used by tests);
 * pass null to fall back to the live `localStorage.gfDebug` flag.
 */
export function setDebugLoggingEnabled(value: boolean | null): void {
    override = value
}

/** Whether debug logging is currently on. */
export function isDebugLoggingEnabled(): boolean {
    return enabled()
}

/**
 * Log a namespaced debug line when logging is enabled; a no-op otherwise.
 * `scope` is a short tag (e.g. 'highlight', 'pill', 'field') and `data` is an
 * optional structured payload. Never logs raw field TEXT — callers pass
 * lengths / counts / offsets, not the user's content (privacy invariant #1).
 */
export function debugLog(scope: string, message: string, data?: unknown): void {
    if (!enabled()) return
    // oxlint-disable-next-line no-console
    if (data === undefined) console.log(`${PREFIX} ${scope}: ${message}`)
    // oxlint-disable-next-line no-console
    else console.log(`${PREFIX} ${scope}: ${message}`, data)
}

/**
 * Log a warning regardless of the debug flag — for genuine errors (a failed
 * bridge call, an unexpected throw) the maintainer should always see. Kept
 * here so all `console` access is centralized.
 */
export function debugWarn(scope: string, message: string, data?: unknown): void {
    // oxlint-disable-next-line no-console
    if (data === undefined) console.warn(`${PREFIX} ${scope}: ${message}`)
    // oxlint-disable-next-line no-console
    else console.warn(`${PREFIX} ${scope}: ${message}`, data)
}
