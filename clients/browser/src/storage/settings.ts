import { storage } from '#imports'
import { resolveCommonSettings } from './settings-core'
import type { Goals } from '@/api/types'

/** Default writing goals (W3-2) — the W2b review panel + the muted-style
 *  filter + the rephrase default tone all read from this. `audience` is
 *  currently unused by the panel (no /tone call yet); `formality` drives
 *  the style-mute + rephrase default tone. `domain` is reserved for a
 *  future LLM prompt header. */
export const DEFAULT_GOALS: Goals = {
    audience: 'general',
    formality: 'neutral',
}

/**
 * Persistent settings for the browser extension. Lives in `browser.storage.local`
 * ONLY — the bridge host and block list must never leave the device
 * (spec §9, privacy invariant #1). The user dictionary is now stored on the
 * bridge itself (shared across every client on this bridge), not in this
 * storage area.
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
    rephraseHotkey: string
    /**
     * When true, set `spellcheck="false"` on every monitored field so the
     * browser's native red squiggles don't double up with GrammarForge
     * highlights. The field's ORIGINAL `spellcheck` attribute is recorded on
     * attach and restored on detach/teardown (we never clobber a page that set
     * it deliberately). Off by default; opt-in (privacy invariant unaffected —
     * this only touches the page DOM, no network).
     */
    suppressNativeSpellcheck: boolean
    /** When true, the content script emits verbose lifecycle logs to the page
     *  console (field attach/detach, render, highlight reconcile). Off by
     *  default. Never logs field TEXT (counts/offsets only). `localStorage
     *  .gfDebug` remains a manual override for one-off debugging. */
    debugLogging: boolean
    /** Rephrase tone/style presets ('' = none) + alternatives count (1 = single). */
    rephraseTone: string
    rephraseStyle: string
    rephraseAlternatives: number
    /** Optional rephrase backend override (provider/base_url/model/api_key).
     *  Absent => use the bridge's default rephrase backend. The api_key lives in
     *  browser.storage.local (user opt-in) and is sent to the bridge per call. */
    rephraseOverride?: {
        provider: 'openai' | 'anthropic'
        baseUrl: string
        model: string
        apiKey: string
    }
    /**
     * Writing goals (W3-2) — the W2b review panel + the muted-style
     * filter + the rephrase default tone all read from this. `audience`
     * is currently unused by the panel (no /tone call yet);
     * `formality === 'informal'` mutes style suggestions; `formality`
     * also seeds the rephrase card's tone picker.
     */
    goals: Goals
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
    acceptHotkey: 'Alt+Period',
    onDemandHotkey: 'Ctrl+Shift+Period',
    rephraseHotkey: 'Ctrl+/',
    suppressNativeSpellcheck: true,
    debugLogging: false,
    rephraseTone: '',
    rephraseStyle: '',
    rephraseAlternatives: 1,
    goals: DEFAULT_GOALS,
}

/**
 * The `local:` area scopes to `browser.storage.local`. We deliberately do NOT
 * expose a `sync:` variant — the spec's privacy invariant forbids pushing the
 * bridge host through Chrome sync.
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
    const stored = (await settingsItem.getValue()) ?? {}
    // Drop stored `undefined` values: a spread would let them CLOBBER the
    // default (e.g. a bad patch permanently disabling a feature) — the merge
    // exists precisely so missing/undefined fields fall back to defaults.
    const defined = Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== undefined))
    // The common fields are validated by the shared resolver. The browser
    // stores bridgeUrl as `bridgeBaseUrl`; remap for the resolver so it
    // can validate the URL format and strip trailing slashes. Invalid stored
    // values (e.g. garbage realtimeDelayMs) are normalised to defaults —
    // this is a deliberate fix over the old pass-through behaviour.
    const rawForResolver: Record<string, unknown> = {
        ...defined,
        bridgeUrl: defined.bridgeBaseUrl,
    }
    const { common } = resolveCommonSettings(rawForResolver)
    // Goals: merge over DEFAULT_GOALS so a partial stored object (e.g. a
    // 2026 build that only persisted `audience`) still gets the missing
    // field's default. Without this the panel would crash on
    // `goals.formality` and the muted-style filter would never apply.
    const storedGoals = (defined.goals ?? {}) as Partial<Goals>
    const goals: Goals = {
        ...DEFAULT_GOALS,
        ...storedGoals,
    }
    return {
        ...DEFAULT_SETTINGS,
        ...defined,
        bridgeBaseUrl: common.bridgeUrl,
        realtimeDelayMs: common.realtimeDelayMs,
        allowRemoteBridge: common.allowRemoteBridge,
        goals,
    } as Settings
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
