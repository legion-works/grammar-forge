// Gated debug logger for the content-script overlay lifecycle (highlight +
// pill rendering, field attach/detach, scroll remeasure). OFF by default so a
// production install is silent — privacy invariant #1 means we never emit
// telemetry, and a public install shouldn't spam the page console.
//
// Turn it on from the page console (persists across reloads, per-origin):
//   localStorage.gfDebug = '1'      // enable
//   delete localStorage.gfDebug     // disable
// Then reload. The flag is read ONCE at module init (cheap; no per-call
// storage read on the hot path). A namespaced prefix ('[gf]') makes the lines
// easy to filter in DevTools.
//
// This is the SINGLE place `console` is touched on the overlay hot path, so
// the oxlint `no-console` disable lives here only; call sites stay clean.

const PREFIX = '[gf]'

/**
 * Whether debug logging is enabled. Read once at init from
 * `localStorage.gfDebug` (any truthy value enables). Guarded in a try/catch
 * because some sandboxed pages throw on `localStorage` access.
 */
function readEnabled(): boolean {
    try {
        return (
            typeof localStorage !== 'undefined' &&
            localStorage.getItem('gfDebug') != null &&
            localStorage.getItem('gfDebug') !== '' &&
            localStorage.getItem('gfDebug') !== '0'
        )
    } catch {
        return false
    }
}

let enabled = readEnabled()

/** Force the enabled state (used by tests; production flips via localStorage). */
export function setDebugLoggingEnabled(value: boolean): void {
    enabled = value
}

/** Whether debug logging is currently on. */
export function isDebugLoggingEnabled(): boolean {
    return enabled
}

/**
 * Log a namespaced debug line when logging is enabled; a no-op otherwise.
 * `scope` is a short tag (e.g. 'highlight', 'pill', 'field') and `data` is an
 * optional structured payload. Never logs raw field TEXT — callers pass
 * lengths / counts / offsets, not the user's content (privacy invariant #1).
 */
export function debugLog(scope: string, message: string, data?: unknown): void {
    if (!enabled) return
    // oxlint-disable-next-line no-console
    if (data === undefined) console.debug(`${PREFIX} ${scope}: ${message}`)
    // oxlint-disable-next-line no-console
    else console.debug(`${PREFIX} ${scope}: ${message}`, data)
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
