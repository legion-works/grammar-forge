import { storage } from '#imports'

/**
 * Persistent settings for the browser extension. Lives in `browser.storage.local`
 * ONLY — the bridge host, personal dictionary, and block list must never leave
 * the device (spec §9, privacy invariant #1).
 */
export interface Settings {
    bridgeBaseUrl: string
    allowRemoteBridge: boolean
    realtimeDelayMs: number
    /**
     * After a paste/drop, suppress the grammar check for this many ms so the
     * user can edit the pasted text before GrammarForge flags it. The check
     * runs again on the next non-paste edit OR when this window expires,
     * whichever comes first. Re-arms on every paste. 0 disables the grace
     * (paste is checked on the normal realtime debounce like any other edit).
     */
    pasteGraceMs: number
    checkMode: 'realtime' | 'ondemand'
    enabled: boolean
    blockedSites: string[]
    checkPastedText: boolean
    picky: boolean
    autocorrect: boolean
    acceptHotkey: string
    onDemandHotkey: string
    personalDictionary: string[]
}

export const DEFAULT_SETTINGS: Settings = {
    bridgeBaseUrl: 'http://localhost:8000',
    allowRemoteBridge: false,
    realtimeDelayMs: 500,
    pasteGraceMs: 4000,
    checkMode: 'realtime',
    enabled: true,
    blockedSites: [],
    checkPastedText: true,
    picky: false,
    autocorrect: false,
    acceptHotkey: 'Ctrl+.',
    onDemandHotkey: 'Ctrl+Shift+Period',
    personalDictionary: [],
}

/**
 * The `local:` area scopes to `browser.storage.local`. We deliberately do NOT
 * expose a `sync:` variant — the spec's privacy invariant forbids pushing the
 * bridge host or personal dictionary through Chrome sync.
 */
export const settingsItem = storage.defineItem<Settings>('local:settings', {
    fallback: DEFAULT_SETTINGS,
})

/**
 * Read the persisted settings (returns defaults when nothing is stored).
 *
 * Merges the stored object OVER DEFAULT_SETTINGS so a settings object written
 * by an OLDER build (missing a field added since, e.g. `pasteGraceMs`) still
 * gets that field's default instead of `undefined`. Without this, a field
 * added later reads back undefined for existing users and silently disables
 * the feature that depends on it.
 */
export async function getSettings(): Promise<Settings> {
    return { ...DEFAULT_SETTINGS, ...(await settingsItem.getValue()) }
}

/**
 * Merge-patch settings into storage. Only the supplied fields are written;
 * the rest of the persisted object is preserved.
 */
export async function setSettings(patch: Partial<Settings>): Promise<void> {
    if (Object.keys(patch).length === 0) return
    const current = await getSettings()
    await settingsItem.setValue({ ...current, ...patch })
}

/**
 * Decide whether the extension is suppressed for a given hostname.
 * `blockedSites` is a flat deny-list: enabled everywhere except these exact
 * hostnames (no subdomain/parent inferral).
 */
export function isSiteBlocked(settings: Settings, hostname: string): boolean {
    return settings.blockedSites.includes(hostname)
}
