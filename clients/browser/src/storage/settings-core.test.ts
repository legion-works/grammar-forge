// clients/browser/src/storage/settings-core.test.ts
import { describe, expect, it } from 'vitest'
import {
    resolveCommonSettings,
    resolveCommonSettingsWithFloor,
    DEFAULT_COMMON_SETTINGS,
} from './settings-core'

describe('resolveCommonSettings', () => {
    it('applies defaults for missing/invalid values', () => {
        expect(resolveCommonSettings({}).common).toEqual(DEFAULT_COMMON_SETTINGS)
    })
    it('handles undefined input', () => {
        expect(resolveCommonSettings(undefined).common).toEqual(DEFAULT_COMMON_SETTINGS)
    })
    it('strips a trailing slash from the bridge URL', () => {
        expect(resolveCommonSettings({ bridgeUrl: 'http://localhost:8000/' }).common.bridgeUrl)
            .toBe('http://localhost:8000')
    })
    it('rejects non-http(s) URLs and falls back to the default', () => {
        expect(resolveCommonSettings({ bridgeUrl: 'ftp://x' }).common.bridgeUrl)
            .toBe('http://localhost:8000')
        expect(resolveCommonSettings({ bridgeUrl: 'not-a-url' }).common.bridgeUrl)
            .toBe('http://localhost:8000')
    })
    it('passes through a valid http URL', () => {
        expect(resolveCommonSettings({ bridgeUrl: 'http://bridge.local:9000' }).common.bridgeUrl)
            .toBe('http://bridge.local:9000')
    })
    it('falls back to the default for non-finite realtimeDelayMs', () => {
        expect(resolveCommonSettings({ realtimeDelayMs: NaN }).common.realtimeDelayMs).toBe(500)
        expect(resolveCommonSettings({ realtimeDelayMs: Infinity }).common.realtimeDelayMs).toBe(500)
        expect(resolveCommonSettings({ realtimeDelayMs: '500' }).common.realtimeDelayMs).toBe(500)
    })
    it('passes through a finite number', () => {
        expect(resolveCommonSettings({ realtimeDelayMs: 750 }).common.realtimeDelayMs).toBe(750)
    })
    it('allowRemoteBridge is strict === true', () => {
        expect(resolveCommonSettings({ allowRemoteBridge: true }).common.allowRemoteBridge).toBe(true)
        expect(resolveCommonSettings({ allowRemoteBridge: 1 }).common.allowRemoteBridge).toBe(false)
        expect(resolveCommonSettings({ allowRemoteBridge: 'true' }).common.allowRemoteBridge).toBe(false)
    })
    it('reports which fields were applied from the input', () => {
        const out = resolveCommonSettings({ bridgeUrl: 'http://x', realtimeDelayMs: 100 })
        expect(out.applied).toEqual({ bridgeUrl: true, realtimeDelayMs: true, allowRemoteBridge: false })
    })
})

describe('resolveCommonSettingsWithFloor', () => {
    it('clamps realtimeDelayMs to the supplied floor', () => {
        const out = resolveCommonSettingsWithFloor({ realtimeDelayMs: 10 }, 150)
        expect(out.common.realtimeDelayMs).toBe(150)
    })
    it('passes through values at or above the floor', () => {
        const out = resolveCommonSettingsWithFloor({ realtimeDelayMs: 500 }, 150)
        expect(out.common.realtimeDelayMs).toBe(500)
    })
})
