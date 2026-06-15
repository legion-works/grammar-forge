import { describe, expect, it } from 'vitest'
import { resolveConfig } from './settings'

describe('resolveConfig', () => {
    it('applies defaults for missing/invalid values', () => {
        const cfg = resolveConfig({})
        expect(cfg.bridgeUrl).toBe('http://localhost:8000')
        expect(cfg.realtimeDelayMs).toBe(500)
        expect(cfg.acceptHotkey).toBe('ctrl+.')
        expect(cfg.rephraseHotkey).toBe('ctrl+/')
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

    // W3-3: goals persistence. The Goals object drives the visible-items
    // filter (informal mutes style) + the rephrase tone seed + the panel
    // header label. resolveConfig validates the raw values and falls back
    // to the default for any field that doesn't match the union.
    it('applies the default goals (general / neutral) when missing or empty', () => {
        const cfg = resolveConfig({})
        expect(cfg.goals).toEqual({ audience: 'general', formality: 'neutral' })
        const nullCfg = resolveConfig({ goals: null })
        expect(nullCfg.goals).toEqual({ audience: 'general', formality: 'neutral' })
    })
    it('accepts valid audience + formality values', () => {
        const cfg = resolveConfig({
            goals: { audience: 'expert', formality: 'formal' },
        })
        expect(cfg.goals).toEqual({ audience: 'expert', formality: 'formal' })
    })
    it('falls back to defaults for unknown audience / formality', () => {
        const cfg = resolveConfig({
            goals: { audience: 'unknown-audience', formality: 'gibberish' },
        })
        expect(cfg.goals).toEqual({ audience: 'general', formality: 'neutral' })
    })
    it('partially-valid goals fill the bad field with the default and keep the good one', () => {
        const cfg = resolveConfig({
            goals: { audience: 'informed', formality: 'garbage' },
        })
        expect(cfg.goals).toEqual({ audience: 'informed', formality: 'neutral' })
    })
})
