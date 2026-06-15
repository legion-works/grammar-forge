// Plugin configuration. The Vencord settings UI (index.ts) feeds raw store
// values through resolveConfig so every consumer sees validated values.
import { resolveCommonSettingsWithFloor } from '@/storage/settings-core'
import type { Goals } from '@/api/types'

export interface GrammarForgeConfig {
    bridgeUrl: string
    realtimeDelayMs: number
    acceptHotkey: string
    rephraseHotkey: string
    checkPastedText: boolean
    allowRemoteBridge: boolean
    debugLogging: boolean
    goals: Goals
}

const MIN_REALTIME_DELAY_MS = 150

export const DEFAULT_GOALS: Goals = {
    audience: 'general',
    formality: 'neutral',
}

function isAudience(v: unknown): v is Goals['audience'] {
    return v === 'general' || v === 'informed' || v === 'expert'
}
function isFormality(v: unknown): v is Goals['formality'] {
    return v === 'informal' || v === 'neutral' || v === 'formal'
}

function resolveGoals(raw: unknown): Goals {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_GOALS }
    const r = raw as Record<string, unknown>
    const audience = isAudience(r.audience) ? r.audience : DEFAULT_GOALS.audience
    const formality = isFormality(r.formality) ? r.formality : DEFAULT_GOALS.formality
    return { audience, formality }
}

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
        goals: resolveGoals(raw.goals),
    }
}
