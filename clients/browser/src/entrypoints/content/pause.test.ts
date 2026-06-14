import { describe, expect, it } from 'vitest'
import { nextPauseMode } from './pause'
import type { Settings } from '@/storage/settings'

const settings = (over: Partial<Settings> = {}): Settings => ({
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
    suppressNativeSpellcheck: false,
    debugLogging: false,
    rephraseTone: '',
    rephraseStyle: '',
    rephraseAlternatives: 1,
    ...over,
})

describe('nextPauseMode', () => {
    // REGRESSION: startup case — orchestrator initialises currentPauseMode='off'
    // and calls nextPauseMode(s, hostname) once. Old code (with current param)
    // fell through to `return { mode: current }` = 'off', so reconcile ran
    // teardownRuntime() and the full runtime never mounted.
    it('mounts (active) at startup when enabled and site not blocked', () => {
        expect(nextPauseMode(settings(), 'example.com').mode).toBe('active')
    })
    it('reports "off" when the extension is globally disabled', () => {
        expect(nextPauseMode(settings({ enabled: false }), 'example.com').mode).toBe('off')
    })
    it('reports "site-paused" when the current hostname is in the deny-list', () => {
        expect(nextPauseMode(settings({ blockedSites: ['example.com'] }), 'example.com').mode).toBe(
            'site-paused',
        )
    })
    it('reports "active" when enabled and site not blocked (general case)', () => {
        expect(nextPauseMode(settings(), 'example.com').mode).toBe('active')
    })
    it('reports "off" when globally disabled and not in the deny-list', () => {
        expect(nextPauseMode(settings({ enabled: false }), 'example.com').mode).toBe('off')
    })
    it('reports "site-paused" when the hostname is in the deny-list regardless of enabled state', () => {
        expect(nextPauseMode(settings({ blockedSites: ['example.com'] }), 'example.com').mode).toBe(
            'site-paused',
        )
    })
})
