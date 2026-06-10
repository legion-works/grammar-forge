import { describe, expect, it } from 'vitest'
import { resolveConfig } from './settings'

describe('resolveConfig', () => {
    it('applies defaults for missing/invalid values', () => {
        const cfg = resolveConfig({})
        expect(cfg.bridgeUrl).toBe('http://localhost:8000')
        expect(cfg.realtimeDelayMs).toBe(500)
        expect(cfg.acceptHotkey).toBe('ctrl+.')
        expect(cfg.checkPastedText).toBe(false)
        expect(cfg.allowRemoteBridge).toBe(false)
    })
    it('strips a trailing slash from the bridge URL', () => {
        expect(resolveConfig({ bridgeUrl: 'http://localhost:8000/' }).bridgeUrl).toBe(
            'http://localhost:8000',
        )
    })
    it('clamps the debounce window to a sane floor', () => {
        expect(resolveConfig({ realtimeDelayMs: 10 }).realtimeDelayMs).toBe(150)
    })
})
