// Pluggable debug-log backends. The shared debug-log core delegates the
// actual write to a `DebugBackend`; the browser client uses the default
// (Console + LocalStorage override), Vencord uses Console with a
// relative-time prefix, OpenCode uses the File backend (append-only,
// no rotation, fsync-off). All backends swallow write errors — debug
// instrumentation must never break the host.

export type DebugLevel = 'info' | 'warn' | 'error'

export interface DebugBackend {
    enabled: () => boolean
    log: (level: DebugLevel, scope: string, message: string, data?: unknown) => void
}

// ---------- Console backend ----------

export interface ConsoleBackendOptions {
    /** Prefix printed before the scope:message, e.g. '[gf]' or '[GrammarForge +5.3ms]'. */
    prefix?: string
    /** Test-only override; production leaves this null and the backend is always on. */
    isEnabled?: () => boolean
    /** Optional log/warn overrides (tests spy on these). */
    out?: { log: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

export function createConsoleBackend(opts: ConsoleBackendOptions = {}): DebugBackend {
    const fallbackLog = (...a: unknown[]): void => {
        // oxlint-disable-next-line no-console
        console.log(...a)
    }
    const fallbackWarn = (...a: unknown[]): void => {
        // oxlint-disable-next-line no-console
        console.warn(...a)
    }
    const log = opts.out?.log ?? fallbackLog
    const warn = opts.out?.warn ?? fallbackWarn
    const prefix = opts.prefix ?? '[gf]'
    const isEnabled = opts.isEnabled ?? (() => true)
    return {
        enabled: isEnabled,
        log: (level, scope, message, data) => {
            if (!isEnabled()) return
            const line = scope ? `${prefix} ${scope}: ${message}` : `${prefix} ${message}`
            const fn = level === 'warn' ? warn : log
            if (data === undefined) fn(line)
            else fn(line, data)
        },
    }
}

// ---------- File backend (Node fs; OpenCode only) ----------

export interface FileBackendOptions {
    path: string
    isEnabled: () => boolean
    /** Indirected so tests can spy on writes without a real filesystem. */
    append?: (path: string, line: string) => void
    nowIso?: () => string
}

export function createFileBackend(opts: FileBackendOptions): DebugBackend {
    const append =
        opts.append ??
        ((p, line) => {
            // node:fs is loaded lazily so the browser bundle never sees it.
            // OpenCode is the only caller; the browser/vendored code paths
            // never reach createFileBackend. The `globalThis` lookup
            // dodges tsc contexts without @types/node (e.g. vencord).
            const nodeRequire = (globalThis as { require?: (id: string) => unknown }).require
            if (typeof nodeRequire !== 'function') return
            // Structural typing — only the one method we use. Avoids
            // resolving 'node:fs' at type-check time in non-Node contexts.
            type NodeFs = {
                appendFileSync: (p: string, d: string, enc: string) => void
            }
            const fs = nodeRequire('node:fs') as NodeFs
            fs.appendFileSync(p, line, 'utf8')
        })
    const now = opts.nowIso ?? (() => new Date().toISOString())
    return {
        enabled: opts.isEnabled,
        log: (level, scope, message, data) => {
            if (!opts.isEnabled()) return
            try {
                const head = scope ? `${level}|${scope}: ${message}` : `${level}|${message}`
                const line = `${now()}|${head}|${JSON.stringify(data ?? null)}\n`
                append(opts.path, line)
            } catch {
                // Swallow — debug instrumentation must never break the host.
            }
        },
    }
}

// ---------- LocalStorage override backend (browser only) ----------

export interface LocalStorageOverrideOptions {
    storageKey: string
    inner: DebugBackend
}

export function createLocalStorageOverrideBackend(opts: LocalStorageOverrideOptions): DebugBackend {
    return {
        enabled: () => {
            if (!opts.inner.enabled()) return false
            try {
                if (typeof localStorage === 'undefined') return false
                const v = localStorage.getItem(opts.storageKey)
                return v != null && v !== '' && v !== '0'
            } catch {
                return false
            }
        },
        log: opts.inner.log,
    }
}
