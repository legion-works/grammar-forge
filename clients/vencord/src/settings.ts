// Plugin configuration. The Vencord settings UI (index.ts) feeds raw store
// values through resolveConfig so every consumer sees validated values.
import { resolveCommonSettingsWithFloor } from '@/storage/settings-core'

export interface GrammarForgeConfig {
    bridgeUrl: string
    realtimeDelayMs: number
    acceptHotkey: string
    rephraseHotkey: string
    checkPastedText: boolean
    allowRemoteBridge: boolean
    debugLogging: boolean
}

const MIN_REALTIME_DELAY_MS = 150

export function resolveConfig(raw: Record<string, unknown>): GrammarForgeConfig {
    const { common } = resolveCommonSettingsWithFloor(raw, MIN_REALTIME_DELAY_MS)
    return {
        bridgeUrl: common.bridgeUrl,
        realtimeDelayMs: common.realtimeDelayMs,
        acceptHotkey:
            typeof raw.acceptHotkey === 'string' && raw.acceptHotkey.trim() !== ''
                ? raw.acceptHotkey.trim().toLowerCase()
                : 'ctrl+.',
        rephraseHotkey:
            typeof raw.rephraseHotkey === 'string' && raw.rephraseHotkey.trim() !== ''
                ? raw.rephraseHotkey.trim().toLowerCase()
                : 'ctrl+/',
        checkPastedText: raw.checkPastedText === true,
        allowRemoteBridge: common.allowRemoteBridge,
        debugLogging: raw.debugLogging === true,
    }
}
