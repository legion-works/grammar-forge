import { describe, expect, it } from 'vitest'
import {
    arcOffset,
    BAND_COLOR,
    computeScore,
    confLabel,
    CONF_COLOR,
    defaultToneFromGoals,
    highConfidenceItems,
    makeInsights,
    mutedStyleCount,
    orbState,
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

describe('computeScore (penalty weights from reference DC)', () => {
    it('returns 100 when there are no items', () => {
        expect(computeScore([])).toBe(100)
    })
    it('deducts the spelling penalty (5 points)', () => {
        expect(computeScore([item({ category: 'spelling' })])).toBe(95)
    })
    it('deducts the grammar penalty (4 points)', () => {
        expect(computeScore([item({ category: 'grammar' })])).toBe(96)
    })
    it('deducts the punctuation penalty (3 points)', () => {
        expect(computeScore([item({ category: 'punctuation' })])).toBe(97)
    })
    it('deducts the style penalty (2 points)', () => {
        expect(computeScore([item({ category: 'style' })])).toBe(98)
    })
    it('deducts the typography penalty (1 point)', () => {
        expect(computeScore([item({ category: 'typography' })])).toBe(99)
    })
    it('sums penalties across multiple open items', () => {
        // 1 spelling (5) + 1 grammar (4) + 1 punctuation (3) = 12
        const items = [
            item({ category: 'spelling' }),
            item({ category: 'grammar' }),
            item({ category: 'punctuation' }),
        ]
        expect(computeScore(items)).toBe(88)
    })
    it('the "1 spelling + 1 grammar" canonical case scores 91 / "excellent"', () => {
        const items = [item({ category: 'spelling' }), item({ category: 'grammar' })]
        expect(computeScore(items)).toBe(91)
        expect(scoreBand(computeScore(items))).toBe('excellent')
    })
    it('floors at 0 (no negative scores)', () => {
        const items = Array.from({ length: 30 }, () => item({ category: 'spelling' }))
        expect(computeScore(items)).toBe(0)
    })
    it('uses the unknown-category fallback penalty (1 point)', () => {
        // The union type doesn't include 'unknown' on RenderableItem, but the
        // runtime value can drift if the bridge returns one.
        const items = [item({ category: 'unknown' as unknown as RenderableItem['category'] })]
        expect(computeScore(items)).toBe(99)
    })
})

describe('scoreBand', () => {
    it('maps 95 to excellent', () => {
        expect(scoreBand(95)).toBe('excellent')
    })
    it('maps 90 (inclusive lower bound) to excellent', () => {
        expect(scoreBand(90)).toBe('excellent')
    })
    it('maps 89 (just below excellent) to good', () => {
        expect(scoreBand(89)).toBe('good')
    })
    it('maps 80 to good', () => {
        expect(scoreBand(80)).toBe('good')
    })
    it('maps 78 (inclusive lower bound) to good', () => {
        expect(scoreBand(78)).toBe('good')
    })
    it('maps 77 (just below good) to fair', () => {
        expect(scoreBand(77)).toBe('fair')
    })
    it('maps 65 to fair', () => {
        expect(scoreBand(65)).toBe('fair')
    })
    it('maps 60 (inclusive lower bound) to fair', () => {
        expect(scoreBand(60)).toBe('fair')
    })
    it('maps 59 (just below fair) to needs-work', () => {
        expect(scoreBand(59)).toBe('needs-work')
    })
    it('maps 50 to needs-work', () => {
        expect(scoreBand(50)).toBe('needs-work')
    })
    it('maps 0 to needs-work', () => {
        expect(scoreBand(0)).toBe('needs-work')
    })
})

describe('arcOffset (r=24.5 ring, circumference 153.9)', () => {
    it('returns 0 for score 100 (full ring)', () => {
        expect(arcOffset(100)).toBeCloseTo(0)
    })
    it('returns the full circumference 153.9 for score 0', () => {
        expect(arcOffset(0)).toBeCloseTo(153.9)
    })
    it('is linear: score 50 should be half the circumference', () => {
        expect(arcOffset(50)).toBeCloseTo(153.9 / 2)
    })
    it('score 90 (lower edge of excellent) yields 15.39', () => {
        expect(arcOffset(90)).toBeCloseTo(15.39)
    })
})

describe('BAND_COLOR (reference DC palette)', () => {
    it('excellent is the green #16a34a', () => {
        expect(BAND_COLOR.excellent).toBe('#16a34a')
    })
    it('good is the cyan #0891b2', () => {
        expect(BAND_COLOR.good).toBe('#0891b2')
    })
    it('fair is the amber #d97706', () => {
        expect(BAND_COLOR.fair).toBe('#d97706')
    })
    it('needs-work is the red #dc2626', () => {
        expect(BAND_COLOR['needs-work']).toBe('#dc2626')
    })
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

describe('confLabel / CONF_COLOR (correction-card conf bar)', () => {
    it('maps confidence >= 0.9 to "High" green', () => {
        expect(confLabel(0.95)).toBe('High')
        expect(confLabel(0.9)).toBe('High')
        expect(CONF_COLOR.High).toBe('#16a34a')
    })
    it('maps confidence 0.75..0.9 to "Medium" amber', () => {
        expect(confLabel(0.75)).toBe('Medium')
        expect(confLabel(0.8)).toBe('Medium')
        expect(CONF_COLOR.Medium).toBe('#d97706')
    })
    it('maps confidence < 0.75 to "Low" slate', () => {
        expect(confLabel(0.5)).toBe('Low')
        expect(confLabel(0.7499)).toBe('Low')
        expect(CONF_COLOR.Low).toBe('#64748b')
    })
    it('treats undefined as 0 → "Low"', () => {
        expect(confLabel(undefined)).toBe('Low')
    })
})

describe('makeInsights (reference DC math)', () => {
    it('empty string yields 0 words, 1 sentence (floor), grade 6, "Clear", 1 sec (floor)', () => {
        const i = makeInsights('')
        expect(i.words).toBe(0)
        expect(i.sentences).toBe(1)
        expect(i.wordsPerSentence).toBe(0)
        expect(i.grade).toBe(6)
        expect(i.readLabel).toBe('Clear')
        expect(i.readSecs).toBe(1)
    })
    it('whitespace-only string is treated as empty (0 words)', () => {
        const i = makeInsights('   \n\t  ')
        expect(i.words).toBe(0)
        expect(i.sentences).toBe(1)
    })
    it('single sentence, 10 words, wps=10 → grade 6 / "Clear"', () => {
        const text = 'one two three four five six seven eight nine ten.'
        const i = makeInsights(text)
        expect(i.words).toBe(10)
        expect(i.sentences).toBe(1)
        expect(i.wordsPerSentence).toBe(10)
        expect(i.grade).toBe(6)
        expect(i.readLabel).toBe('Clear')
        // 10/200*60 = 3 sec
        expect(i.readSecs).toBe(3)
    })
    it('3 sentences (split on .!?), 12 words → wps=4 → grade 6 / "Clear"', () => {
        const text = 'one two three. four five six. seven eight nine ten eleven twelve.'
        const i = makeInsights(text)
        expect(i.words).toBe(12)
        expect(i.sentences).toBe(3)
        expect(i.wordsPerSentence).toBe(4)
        expect(i.grade).toBe(6)
        expect(i.readLabel).toBe('Clear')
    })
    it('wps=15 is in the [13,17) band → grade 8 / "Clear"', () => {
        // 15 words, 1 sentence → wps=15
        const words = Array.from({ length: 15 }, (_, i) => `w${i}`).join(' ') + '.'
        const i = makeInsights(words)
        expect(i.words).toBe(15)
        expect(i.wordsPerSentence).toBe(15)
        expect(i.grade).toBe(8)
        expect(i.readLabel).toBe('Clear')
    })
    it('wps=17 is the boundary: still "Clear" (<17) but 200 words/1 sent is "Dense" wps=200', () => {
        // Just below the cut-off (16 wps) — grade 8, "Clear".
        const words = Array.from({ length: 16 }, (_, i) => `w${i}`).join(' ') + '.'
        expect(makeInsights(words).grade).toBe(8)
        expect(makeInsights(words).readLabel).toBe('Clear')
        // At the cut-off (17 wps) — the rule is <17 = "Clear", so 17 = "Dense"
        const words17 = Array.from({ length: 17 }, (_, i) => `w${i}`).join(' ') + '.'
        expect(makeInsights(words17).wordsPerSentence).toBe(17)
        expect(makeInsights(words17).readLabel).toBe('Dense')
    })
    it('wps >= 17 → grade 11 / "Dense"', () => {
        const words = Array.from({ length: 25 }, (_, i) => `w${i}`).join(' ') + '.'
        const i = makeInsights(words)
        expect(i.words).toBe(25)
        expect(i.wordsPerSentence).toBe(25)
        expect(i.grade).toBe(11)
        expect(i.readLabel).toBe('Dense')
    })
    it('readSecs = max(1, round(words/200*60))', () => {
        // 200 words, 1 sentence, 1 minute exactly.
        const words = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ') + '.'
        expect(makeInsights(words).readSecs).toBe(60)
        // 400 words → 120 sec.
        const words400 = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ') + '.'
        expect(makeInsights(words400).readSecs).toBe(120)
        // floor: 1 word, 1 sec.
        expect(makeInsights('hello.').readSecs).toBe(1)
    })
    it('multiple terminal punctuation marks in one sentence are counted individually (DC verbatim)', () => {
        // The DC rule is "count every [.|!|?]+ cluster" — not "count
        // sentence boundaries." This case documents the (intentional)
        // behaviour: "Wait! Really? Yes." → 3 clusters.
        const text = 'Wait! Really? Yes.'
        const i = makeInsights(text)
        expect(i.words).toBe(3)
        expect(i.sentences).toBe(3)
        // floor of 1 means an empty string still reports 1.
        expect(makeInsights('').sentences).toBe(1)
    })
})

describe('orbState (per-field score orb)', () => {
    it('disabled wins over every other state', () => {
        // Even with a fresh score + a fast phase + a non-zero count, the
        // site-paused state always shows the power glyph — single,
        // unambiguous affordance for the user.
        const s = orbState({ score: 100, openCount: 5, phase: 'fast', disabled: true })
        expect(s.center).toBe('power')
        expect(s.count).toBe(0)
    })
    it('disabled still computes a sensible ring color/offset (no NaN, no throw)', () => {
        // Guard against the pure helper bailing out for the disabled branch.
        const s = orbState({ openCount: 0, phase: 'done', disabled: true })
        expect(Number.isFinite(s.ringOffset)).toBe(true)
        expect(s.ringColor).toMatch(/^#[0-9a-f]{6}$/i)
    })
    it("phase='fast' with openCount > 0 shows the AI pip (not a stale count)", () => {
        const s = orbState({ score: 90, openCount: 3, phase: 'fast', disabled: false })
        expect(s.center).toBe('pip')
        expect(s.count).toBe(0)
    })
    it("phase='fast' with openCount === 0 still shows ✓ (no pip when there is nothing to refine)", () => {
        const s = orbState({ score: 100, openCount: 0, phase: 'fast', disabled: false })
        expect(s.center).toBe('clean')
    })
    it("openCount === 0 with phase='done' shows ✓", () => {
        const s = orbState({ score: 100, openCount: 0, phase: 'done', disabled: false })
        expect(s.center).toBe('clean')
    })
    it("openCount > 0 with phase='done' shows the count number", () => {
        const s = orbState({ score: 80, openCount: 4, phase: 'done', disabled: false })
        expect(s.center).toBe('count')
        expect(s.count).toBe(4)
    })
    it('ring offset derives from the score via arcOffset (no re-derivation)', () => {
        const s = orbState({ score: 60, openCount: 2, phase: 'done', disabled: false })
        // arcOffset(60) = 153.9 * (1 - 0.6) = 61.56 — consumed, not recomputed
        expect(s.ringOffset).toBeCloseTo(arcOffset(60))
        expect(s.ringOffset).toBeCloseTo(61.56)
    })
    it('ring offset is 0 (full ring) when score is undefined (no check yet)', () => {
        const s = orbState({ openCount: 0, phase: 'done', disabled: false })
        expect(s.ringOffset).toBeCloseTo(0)
    })
    it('ring color derives from the score band via BAND_COLOR (no re-derivation)', () => {
        // score 95 → excellent → green
        const excellent = orbState({ score: 95, openCount: 1, phase: 'done', disabled: false })
        expect(excellent.ringColor).toBe(BAND_COLOR.excellent)
        // score 70 → fair → amber
        const fair = orbState({ score: 70, openCount: 1, phase: 'done', disabled: false })
        expect(fair.ringColor).toBe(BAND_COLOR.fair)
        // score 50 → needs-work → red
        const needs = orbState({ score: 50, openCount: 1, phase: 'done', disabled: false })
        expect(needs.ringColor).toBe(BAND_COLOR['needs-work'])
    })
    it('an explicit band short-circuits the score→band lookup (caller already has it)', () => {
        // Pass band=good, score=50 (which would normally resolve to needs-work).
        // The caller is the source of truth — we render what it says.
        const s = orbState({ score: 50, band: 'good', openCount: 1, phase: 'done', disabled: false })
        expect(s.ringColor).toBe(BAND_COLOR.good)
    })
    it('ring offset uses the score (not the band) — band only drives the color', () => {
        // Same band, different scores → different offsets.
        const a = orbState({ score: 90, band: 'excellent', openCount: 1, phase: 'done', disabled: false })
        const b = orbState({ score: 60, band: 'excellent', openCount: 1, phase: 'done', disabled: false })
        expect(a.ringOffset).toBeCloseTo(arcOffset(90))
        expect(b.ringOffset).toBeCloseTo(arcOffset(60))
        // Both share the band → same color.
        expect(a.ringColor).toBe(b.ringColor)
    })
    it('undefined score + count > 0 still falls into the count state (ring reads full)', () => {
        // Pre-check state: the orchestrator has a count but no score yet (it
        // arrives with the first /correct response). The orb shouldn't crash;
        // the ring reads "full + green" until the score arrives.
        const s = orbState({ openCount: 1, phase: 'done', disabled: false })
        expect(s.center).toBe('count')
        expect(s.count).toBe(1)
        expect(s.ringOffset).toBeCloseTo(0)
        expect(s.ringColor).toBe(BAND_COLOR.excellent)
    })
})

// W3-1: the orchestrator's renderField computes the score+band from
// `visibleItems(items, phase, goals)`, then hands the result to the
// status-button as `score` + `band` + `phase`. These tests pin the
// contract: `visibleItems` is the single source of truth for what
// counts toward the score (and the orb's count badge).
describe('visibleItems (W3-1 orchestrator integration)', () => {
    const goals: Goals = { audience: 'general', formality: 'neutral' }
    const informalGoals: Goals = { audience: 'general', formality: 'informal' }
    it("phase='fast' drops LLM items (the streaming preview is local-only)", () => {
        const items: RenderableItem[] = [
            item({ model: 'harper', category: 'spelling' }),
            item({ model: 'llm', category: 'grammar' }),
        ]
        const visible = visibleItems(items, 'fast', goals)
        expect(visible.map((i) => i.model)).toEqual(['harper'])
    })
    it("phase='done' includes LLM items alongside the fast-path rules", () => {
        const items: RenderableItem[] = [
            item({ model: 'harper', category: 'spelling' }),
            item({ model: 'llm', category: 'grammar' }),
        ]
        const visible = visibleItems(items, 'done', goals)
        expect(visible).toHaveLength(2)
    })
    it("informal mutes style items (they vanish from the score + count)", () => {
        const items: RenderableItem[] = [
            item({ model: 'harper', category: 'spelling' }),
            item({ model: 'llm', category: 'style' }),
        ]
        const neutralVisible = visibleItems(items, 'done', goals)
        const informalVisible = visibleItems(items, 'done', informalGoals)
        expect(neutralVisible).toHaveLength(2)
        expect(informalVisible).toHaveLength(1)
        expect(informalVisible[0]?.category).toBe('spelling')
    })
    it('accepted/dismissed items are filtered out (status: open only)', () => {
        const items: RenderableItem[] = [
            item({ status: 'open' }),
            item({ status: 'accepted' }),
            item({ status: 'dismissed' }),
        ]
        const visible = visibleItems(items, 'done', goals)
        expect(visible).toHaveLength(1)
    })
    it('combined fast + informal: only non-style, non-LLM items count', () => {
        const items: RenderableItem[] = [
            item({ model: 'harper', category: 'spelling', status: 'open' }),
            item({ model: 'llm', category: 'grammar', status: 'open' }),
            item({ model: 'llm', category: 'style', status: 'open' }),
            item({ model: 'harper', category: 'style', status: 'open' }),
        ]
        const visible = visibleItems(items, 'fast', informalGoals)
        expect(visible).toHaveLength(1)
        expect(visible[0]?.category).toBe('spelling')
    })
})
