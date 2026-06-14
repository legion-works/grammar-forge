// clients/browser/src/storage/settings-core.ts
// Common settings schema + resolver, shared by all three clients. Each
// client extends with its platform-specific fields and wraps the result
// in its own `*Settings` type. The shared core guarantees that the
// common fields (bridgeUrl, realtimeDelayMs, allowRemoteBridge) are
// validated identically across clients — drift here bit us this session
// (vencord/opencode had slightly different realtime-delay validation).

export const DEFAULT_BRIDGE_URL = 'http://localhost:8000'
export const DEFAULT_REALTIME_DELAY_MS = 500

export interface CommonSettings {
    bridgeUrl: string
    realtimeDelayMs: number
    allowRemoteBridge: boolean
}

export const DEFAULT_COMMON_SETTINGS: CommonSettings = {
    bridgeUrl: DEFAULT_BRIDGE_URL,
    realtimeDelayMs: DEFAULT_REALTIME_DELAY_MS,
    allowRemoteBridge: false,
}

export interface ResolvedCommon {
    common: CommonSettings
    /** The fields the caller did NOT supply; useful for diagnostics. */
    applied: { bridgeUrl: boolean; realtimeDelayMs: boolean; allowRemoteBridge: boolean }
}

/** Validate and normalise the common subset of a raw settings record.
 *  Pass-through for unknown fields; the caller merges with its own
 *  platform-specific defaults. */
export function resolveCommonSettings(raw: Record<string, unknown> | undefined): ResolvedCommon {
    const r = raw ?? {}
    const bridgeUrl =
        typeof r.bridgeUrl === 'string' && /^https?:\/\//.test(r.bridgeUrl)
            ? r.bridgeUrl.replace(/\/+$/, '')
            : DEFAULT_COMMON_SETTINGS.bridgeUrl
    const realtimeDelayMs =
        typeof r.realtimeDelayMs === 'number' && Number.isFinite(r.realtimeDelayMs)
            ? r.realtimeDelayMs
            : DEFAULT_COMMON_SETTINGS.realtimeDelayMs
    const allowRemoteBridge = r.allowRemoteBridge === true
    return {
        common: { bridgeUrl, realtimeDelayMs, allowRemoteBridge },
        applied: {
            bridgeUrl: typeof r.bridgeUrl === 'string',
            realtimeDelayMs: typeof r.realtimeDelayMs === 'number',
            allowRemoteBridge: r.allowRemoteBridge === true,
        },
    }
}

/** Optional floor for realtimeDelayMs (vencord uses 150ms). Pass as a
 *  second arg; the resolver clamps below the floor. */
export function resolveCommonSettingsWithFloor(
    raw: Record<string, unknown> | undefined,
    minRealtimeDelayMs: number,
): ResolvedCommon {
    const r = resolveCommonSettings(raw)
    if (r.common.realtimeDelayMs < minRealtimeDelayMs) {
        r.common.realtimeDelayMs = minRealtimeDelayMs
    }
    return r
}
