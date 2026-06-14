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
    it('reports "off" when the extension is globally disabled', () => {
        expect(nextPauseMode(settings({ enabled: false }), 'active', 'example.com').mode).toBe(
            'off',
        )
    })
    it('reports "site-paused" when the current hostname is in the deny-list', () => {
        expect(
            nextPauseMode(settings({ blockedSites: ['example.com'] }), 'active', 'example.com')
                .mode,
        ).toBe('site-paused')
    })
    it('reports "active" when un-pausing from a previously-paused state', () => {
        expect(nextPauseMode(settings(), 'site-paused', 'example.com').mode).toBe('active')
    })
    it('keeps "active" when already active and still allowed', () => {
        expect(nextPauseMode(settings(), 'active', 'example.com').mode).toBe('active')
    })
    it('keeps "off" when globally off and not in the deny-list (no transition)', () => {
        expect(nextPauseMode(settings({ enabled: false }), 'off', 'example.com').mode).toBe('off')
    })
    it('reports "site-paused" even from "off" when the hostname is in the deny-list (re-enable path)', () => {
        expect(
            nextPauseMode(settings({ blockedSites: ['example.com'] }), 'off', 'example.com').mode,
        ).toBe('site-paused')
    })
})
