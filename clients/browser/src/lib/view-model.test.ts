import { describe, expect, it } from 'vitest'
import {
    arcOffset,
    BAND_COLOR,
    computeScore,
    defaultToneFromGoals,
    highConfidenceItems,
    mutedStyleCount,
    scoreBand,
    visibleItems,
} from './view-model'
import type { RenderableItem } from './pipeline'
import type { Goals } from '../api/types'

const item = (overrides: Partial<RenderableItem> = {}): RenderableItem => ({
    id: 1,
    cuStart: 0,
    cuEnd: 0,
    hlStart: 0,
    hlEnd: 0,
    category: 'spelling',
    message: '',
    replacements: ['the'],
    original: 'teh',
    diffOriginal: 'teh',
    diffCorrected: 'the',
    diffIsDeletion: false,
    byteSpan: { start: 0, end: 3 },
    model: 'harper',
    confidence: 0.95,
    status: 'open',
    ...overrides,
})

const neutralGoals = (): Goals => ({ audience: 'general', formality: 'neutral' })

describe('visibleItems', () => {
    it('hides llm items during the fast phase', () => {
        const items = [item({ model: 'llm' }), item({ model: 'harper' })]
        expect(visibleItems(items, 'fast', neutralGoals())).toHaveLength(1)
        expect(visibleItems(items, 'fast', neutralGoals())[0]!.model).toBe('harper')
    })
    it('shows llm items after the done phase', () => {
        const items = [item({ model: 'llm' })]
        expect(visibleItems(items, 'done', neutralGoals())).toHaveLength(1)
    })
    it('mutes style suggestions when formality=informal', () => {
        const items = [item({ category: 'style' }), item({ category: 'grammar' })]
        const out = visibleItems(items, 'done', { audience: 'general', formality: 'informal' })
        expect(out).toHaveLength(1)
        expect(out[0]!.category).toBe('grammar')
    })
    it('does not mute style when formality=neutral', () => {
        const items = [item({ category: 'style' })]
        expect(visibleItems(items, 'done', neutralGoals())).toHaveLength(1)
    })
    it('does not mute style when formality=formal', () => {
        const items = [item({ category: 'style' })]
        expect(visibleItems(items, 'done', { audience: 'general', formality: 'formal' })).toHaveLength(
            1,
        )
    })
    it('hides dismissed items', () => {
        const items = [item({ status: 'dismissed' }), item({ status: 'accepted' })]
        expect(visibleItems(items, 'done', neutralGoals())).toHaveLength(0)
    })
    it('shows items with status=open', () => {
        const items = [item({ status: 'open' })]
        expect(visibleItems(items, 'done', neutralGoals())).toHaveLength(1)
    })
    it('returns the same array reference for empty input', () => {
        expect(visibleItems([], 'done', neutralGoals())).toEqual([])
    })
})

describe('computeScore', () => {
    it('returns 100 when there are no items', () => {
        expect(computeScore([])).toBe(100)
    })
    it('deducts the spelling penalty (8 points)', () => {
        expect(computeScore([item({ category: 'spelling' })])).toBe(92)
    })
    it('sums penalties across multiple open items', () => {
        const items = [
            item({ category: 'spelling' }),
            item({ category: 'grammar' }),
            item({ category: 'punctuation' }),
        ]
        // 8 + 6 + 4 = 18
        expect(computeScore(items)).toBe(82)
    })
    it('floors at 0 (no negative scores)', () => {
        const items = Array.from({ length: 20 }, () => item({ category: 'spelling' }))
        expect(computeScore(items)).toBe(0)
    })
    it('uses the unknown-category fallback penalty (2 points)', () => {
        // Cast to the broader category to force the fallback path — the union
        // type does not include 'unknown' on RenderableItem, but the runtime
        // value can drift if the bridge returns one.
        const items = [item({ category: 'unknown' as unknown as RenderableItem['category'] })]
        expect(computeScore(items)).toBe(98)
    })
})

describe('scoreBand', () => {
    it('maps 95 to excellent', () => {
        expect(scoreBand(95)).toBe('excellent')
    })
    it('maps 90 (inclusive lower bound) to excellent', () => {
        expect(scoreBand(90)).toBe('excellent')
    })
    it('maps 80 to good', () => {
        expect(scoreBand(80)).toBe('good')
    })
    it('maps 78 (inclusive lower bound) to good', () => {
        expect(scoreBand(78)).toBe('good')
    })
    it('maps 65 to fair', () => {
        expect(scoreBand(65)).toBe('fair')
    })
    it('maps 60 (inclusive lower bound) to fair', () => {
        expect(scoreBand(60)).toBe('fair')
    })
    it('maps 50 to needs-work', () => {
        expect(scoreBand(50)).toBe('needs-work')
    })
    it('maps 0 to needs-work', () => {
        expect(scoreBand(0)).toBe('needs-work')
    })
})

describe('arcOffset', () => {
    it('returns 0 for score 100', () => {
        expect(arcOffset(100)).toBeCloseTo(0)
    })
    it('returns the full circumference for score 0', () => {
        expect(arcOffset(0)).toBeCloseTo(150.8)
    })
    it('is linear: score 50 should be half the circumference', () => {
        expect(arcOffset(50)).toBeCloseTo(150.8 / 2)
    })
})

describe('BAND_COLOR', () => {
    it('has a color for every Band', () => {
        const bands: Array<keyof typeof BAND_COLOR> = ['excellent', 'good', 'fair', 'needs-work']
        for (const b of bands) {
            expect(typeof BAND_COLOR[b]).toBe('string')
            expect(BAND_COLOR[b].startsWith('#')).toBe(true)
        }
    })
})

describe('highConfidenceItems', () => {
    it('filters to items with confidence >= 0.90', () => {
        const items = [item({ confidence: 0.95 }), item({ confidence: 0.80 })]
        const out = highConfidenceItems(items)
        expect(out).toHaveLength(1)
        expect(out[0]!.confidence).toBeGreaterThanOrEqual(0.9)
    })
    it('treats 0.90 as a high-confidence item (inclusive boundary)', () => {
        const items = [item({ confidence: 0.9 })]
        expect(highConfidenceItems(items)).toHaveLength(1)
    })
    it('treats 0.8999 as not high-confidence (just below boundary)', () => {
        const items = [item({ confidence: 0.8999 })]
        expect(highConfidenceItems(items)).toHaveLength(0)
    })
    it('treats undefined confidence as 0 (never high)', () => {
        const items = [item({ confidence: undefined })]
        expect(highConfidenceItems(items)).toHaveLength(0)
    })
    it('keeps the count visible (caller gates 0 < highConf < total)', () => {
        // Pure helper: returns the items; the panel decides whether to show
        // the "Accept high-confidence" button. The helper itself is
        // length-preserving in the boundary case.
        const items = [item({ confidence: 0.95 }), item({ confidence: 0.95 })]
        expect(highConfidenceItems(items)).toHaveLength(2)
    })
})

describe('mutedStyleCount', () => {
    it('counts open style items when formality=informal', () => {
        const items = [item({ category: 'style' }), item({ category: 'grammar' })]
        expect(
            mutedStyleCount(items, { audience: 'general', formality: 'informal' }),
        ).toBe(1)
    })
    it('returns 0 when formality=neutral', () => {
        const items = [item({ category: 'style' })]
        expect(mutedStyleCount(items, neutralGoals())).toBe(0)
    })
    it('returns 0 when formality=formal', () => {
        const items = [item({ category: 'style' })]
        expect(
            mutedStyleCount(items, { audience: 'general', formality: 'formal' }),
        ).toBe(0)
    })
    it('does not count dismissed style items (the count is for the dashed note only)', () => {
        const items = [item({ category: 'style', status: 'dismissed' })]
        expect(
            mutedStyleCount(items, { audience: 'general', formality: 'informal' }),
        ).toBe(0)
    })
})

describe('defaultToneFromGoals', () => {
    it('maps formality=formal to tone=formal', () => {
        expect(defaultToneFromGoals({ audience: 'general', formality: 'formal' })).toBe('formal')
    })
    it('maps formality=informal to tone=casual', () => {
        expect(defaultToneFromGoals({ audience: 'general', formality: 'informal' })).toBe('casual')
    })
    it('maps formality=neutral to tone=neutral', () => {
        expect(defaultToneFromGoals({ audience: 'general', formality: 'neutral' })).toBe('neutral')
    })
})
