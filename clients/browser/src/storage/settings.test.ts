import { afterEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_SETTINGS,
    getSettings,
    isSiteBlocked,
    setSettings,
    settingsItem,
} from '@/storage/settings'

afterEach(async () => {
    await settingsItem.removeValue()
})

describe('settingsItem', () => {
    it('uses local storage (never sync) — privacy: bridge host + dictionary stay on-device', () => {
        // The store key MUST be `local:settings`. A `sync:` key would push the
        // bridge URL + personal dictionary through Chrome sync, which the
        // spec's privacy invariant forbids.
        expect(settingsItem.key).toBe('local:settings')
    })
})

describe('DEFAULT_SETTINGS', () => {
    it('exposes the spec §11 defaults', () => {
        expect(DEFAULT_SETTINGS).toEqual({
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
            personalDictionary: [],
            suppressNativeSpellcheck: false,
            debugLogging: false,
            rephraseTone: '',
            rephraseStyle: '',
            rephraseAlternatives: 1,
        })
    })
})

describe('getSettings', () => {
    it('returns the default settings when nothing has been persisted', async () => {
        expect(await getSettings()).toEqual(DEFAULT_SETTINGS)
    })
})

describe('setSettings', () => {
    it('merge-patches a single field and round-trips', async () => {
        await setSettings({ autocorrect: true })
        expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, autocorrect: true })
    })

    it('merge-patches a list field without overwriting the rest', async () => {
        await setSettings({ blockedSites: ['example.com', 'spam.test'] })
        const s = await getSettings()
        expect(s.blockedSites).toEqual(['example.com', 'spam.test'])
        expect(s.bridgeBaseUrl).toBe(DEFAULT_SETTINGS.bridgeBaseUrl)
        expect(s.acceptHotkey).toBe(DEFAULT_SETTINGS.acceptHotkey)
    })

    it('accepts multiple patches sequentially (last write wins per field)', async () => {
        await setSettings({ autocorrect: true })
        await setSettings({ bridgeBaseUrl: 'http://127.0.0.1:9000' })
        const s = await getSettings()
        expect(s.autocorrect).toBe(true)
        expect(s.bridgeBaseUrl).toBe('http://127.0.0.1:9000')
    })

    it('leaves untouched fields alone when patching an empty object', async () => {
        await setSettings({ personalDictionary: ['lol', 'btw'] })
        await setSettings({})
        const s = await getSettings()
        expect(s.personalDictionary).toEqual(['lol', 'btw'])
    })
})

describe('isSiteBlocked', () => {
    const blocked = ['example.com', 'spam.test']
    it('is true for a host on the deny list', () => {
        expect(isSiteBlocked({ ...DEFAULT_SETTINGS, blockedSites: blocked }, 'example.com')).toBe(
            true,
        )
        expect(isSiteBlocked({ ...DEFAULT_SETTINGS, blockedSites: blocked }, 'spam.test')).toBe(
            true,
        )
    })

    it('is false for a host not on the deny list', () => {
        expect(isSiteBlocked({ ...DEFAULT_SETTINGS, blockedSites: blocked }, 'allowed.com')).toBe(
            false,
        )
    })

    it('is false when the deny list is empty (enabled everywhere by default)', () => {
        expect(isSiteBlocked(DEFAULT_SETTINGS, 'anywhere.com')).toBe(false)
    })

    it('matches the host string exactly (no subdomain/parent inferral)', () => {
        // Spec: blockedSites is a flat list of hostnames; we do not infer
        // subdomains or suffixes. A user who wants both adds both.
        expect(
            isSiteBlocked(
                { ...DEFAULT_SETTINGS, blockedSites: ['example.com'] },
                'www.example.com',
            ),
        ).toBe(false)
        expect(
            isSiteBlocked(
                { ...DEFAULT_SETTINGS, blockedSites: ['www.example.com'] },
                'example.com',
            ),
        ).toBe(false)
    })
})
