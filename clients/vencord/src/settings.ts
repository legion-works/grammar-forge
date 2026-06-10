// Plugin configuration. The Vencord settings UI (index.ts) feeds raw store
// values through resolveConfig so every consumer sees validated values.
export interface GrammarForgeConfig {
    bridgeUrl: string
    realtimeDelayMs: number
    acceptHotkey: string
    checkPastedText: boolean
    allowRemoteBridge: boolean
    debugLogging: boolean
}

const MIN_REALTIME_DELAY_MS = 150

export function resolveConfig(raw: Record<string, unknown>): GrammarForgeConfig {
    const bridgeUrl =
        typeof raw.bridgeUrl === 'string' && /^https?:\/\//.test(raw.bridgeUrl)
            ? raw.bridgeUrl.replace(/\/+$/, '')
            : 'http://localhost:8000'
    const realtimeDelayMs =
        typeof raw.realtimeDelayMs === 'number' && Number.isFinite(raw.realtimeDelayMs)
            ? Math.max(MIN_REALTIME_DELAY_MS, raw.realtimeDelayMs)
            : 500
    return {
        bridgeUrl,
        realtimeDelayMs,
        acceptHotkey:
            typeof raw.acceptHotkey === 'string' && raw.acceptHotkey.trim() !== ''
                ? raw.acceptHotkey.trim().toLowerCase()
                : 'ctrl+.',
        checkPastedText: raw.checkPastedText === true,
        allowRemoteBridge: raw.allowRemoteBridge === true,
        debugLogging: raw.debugLogging === true,
    }
}
