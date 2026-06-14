// Pure-function tests for the correction-card helpers. No DOM needed.
import { describe, expect, it } from 'vitest'
import {
    confidenceBand,
    confidenceBarWidth,
    sourceChipLabel,
    clampNavIndex,
    navLabel,
} from './popover-helpers'

describe('confidenceBand', () => {
    it('maps >= 0.90 to high', () => {
        expect(confidenceBand(0.9)).toBe('high')
        expect(confidenceBand(0.95)).toBe('high')
        expect(confidenceBand(1)).toBe('high')
    })
    it('maps 0.75..0.89 to medium', () => {
        expect(confidenceBand(0.75)).toBe('medium')
        expect(confidenceBand(0.89)).toBe('medium')
    })
    it('maps < 0.75 to low', () => {
        expect(confidenceBand(0.5)).toBe('low')
        expect(confidenceBand(0)).toBe('low')
    })
    it('returns high for undefined (LLM has no score — treat as max)', () => {
        expect(confidenceBand(undefined)).toBe('high')
    })
})

describe('confidenceBarWidth', () => {
    it('returns 100 for undefined', () => {
        expect(confidenceBarWidth(undefined)).toBe(100)
    })
    it('multiplies by 100, rounded to 1 decimal', () => {
        expect(confidenceBarWidth(0.95)).toBe(95)
        expect(confidenceBarWidth(0.99)).toBe(99)
        expect(confidenceBarWidth(0.992)).toBe(99.2)
    })
    it('clamps to 0..100', () => {
        expect(confidenceBarWidth(1.5)).toBe(100)
        expect(confidenceBarWidth(-0.1)).toBe(0)
    })
})

describe('sourceChipLabel', () => {
    it('harper gets the "instant" hint variant', () => {
        const h = sourceChipLabel('harper')
        expect(h.variant).toBe('fast')
        expect(h.text).toContain('Harper')
        expect(h.text).toContain(' · instant')
    })
    it('gector gets the "instant" hint variant', () => {
        const g = sourceChipLabel('gector')
        expect(g.variant).toBe('fast')
        expect(g.text).toContain('GECToR')
        expect(g.text).toContain(' · instant')
    })
    it('llm + lt_rule get the AI variant', () => {
        const llm = sourceChipLabel('llm')
        expect(llm.variant).toBe('ai')
        expect(llm.text).toBe('✨ AI')
        const lt = sourceChipLabel('lt_rule')
        expect(lt.variant).toBe('ai')
        expect(lt.text).toBe('✨ AI')
    })
    it('undefined falls back to AI (LLM-equivalent)', () => {
        const u = sourceChipLabel(undefined)
        expect(u.variant).toBe('ai')
        expect(u.text).toBe('✨ AI')
    })
})

describe('clampNavIndex', () => {
    it('returns null when total is 0', () => {
        expect(clampNavIndex(1, 0)).toBeNull()
    })
    it('returns null when total is undefined', () => {
        expect(clampNavIndex(1, undefined)).toBeNull()
    })
    it('clamps below 1 to 1', () => {
        expect(clampNavIndex(0, 5)).toEqual({ current: 1, total: 5 })
        expect(clampNavIndex(-3, 5)).toEqual({ current: 1, total: 5 })
    })
    it('clamps above total to total', () => {
        expect(clampNavIndex(99, 8)).toEqual({ current: 8, total: 8 })
    })
    it('passes through valid in-range values', () => {
        expect(clampNavIndex(3, 8)).toEqual({ current: 3, total: 8 })
    })
    it('defaults to 1 when navIndex is undefined', () => {
        expect(clampNavIndex(undefined, 8)).toEqual({ current: 1, total: 8 })
    })
    it('truncates fractional values toward zero (Math.floor semantics)', () => {
        expect(clampNavIndex(2.7, 8)).toEqual({ current: 2, total: 8 })
        expect(clampNavIndex(2.4, 8)).toEqual({ current: 2, total: 8 })
    })
    it('rounds fractional total down to integers', () => {
        expect(clampNavIndex(3, 8.9)).toEqual({ current: 3, total: 8 })
    })
})

describe('navLabel', () => {
    it('formats "N of M"', () => {
        expect(navLabel(3, 8)).toBe('3 of 8')
        expect(navLabel(1, 1)).toBe('1 of 1')
    })
})
