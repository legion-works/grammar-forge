import { describe, expect, it } from 'vitest'
import { BAND_COLOR } from '@/lib/view-model'
import { buildPanelModel, groupItemsByCategory } from './panel-model'
import type { RenderableItem } from '@/lib/pipeline'
import type { Goals } from '@/api/types'

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

describe('groupItemsByCategory', () => {
    it('groups items by their category into a single bucket', () => {
        const out = groupItemsByCategory([
            item({ id: 1, category: 'spelling' }),
            item({ id: 2, category: 'spelling' }),
            item({ id: 3, category: 'grammar' }),
        ])
        expect(out).toHaveLength(2)
        const spell = out.find((g) => g.category === 'spelling')
        const gram = out.find((g) => g.category === 'grammar')
        expect(spell?.items.map((i) => i.item.id)).toEqual([1, 2])
        expect(gram?.items.map((i) => i.item.id)).toEqual([3])
    })

    it('preserves the canonical category order (spelling → grammar → punctuation → style → typography → unknown)', () => {
        const out = groupItemsByCategory([
            item({ id: 1, category: 'typography' }),
            item({ id: 2, category: 'spelling' }),
            item({ id: 3, category: 'style' }),
            item({ id: 4, category: 'punctuation' }),
            item({ id: 5, category: 'grammar' }),
        ])
        expect(out.map((g) => g.category)).toEqual([
            'spelling',
            'grammar',
            'punctuation',
            'style',
            'typography',
        ])
    })

    it('skips categories with zero items (no empty groups)', () => {
        const out = groupItemsByCategory([item({ category: 'spelling' })])
        expect(out).toHaveLength(1)
        expect(out[0]?.category).toBe('spelling')
    })

    it('returns an empty list for empty input', () => {
        expect(groupItemsByCategory([])).toEqual([])
    })

    it('each group exposes the per-item dot color + a category label', () => {
        const out = groupItemsByCategory([item({ category: 'spelling' })])
        const g = out[0]!
        expect(g.label).toBe('Spelling')
        expect(g.dot).toBe('#ef4444')
        expect(g.items[0]?.dot).toBe('#ef4444')
    })

    it('emits the right chip label per bridge model', () => {
        const harper = groupItemsByCategory([item({ model: 'harper' })])[0]!.items[0]!
        const gector = groupItemsByCategory([item({ model: 'gector' })])[0]!.items[0]!
        const llm = groupItemsByCategory([item({ model: 'llm' })])[0]!.items[0]!
        const rule = groupItemsByCategory([item({ model: 'lt_rule' })])[0]!.items[0]!
        expect(harper.chipLabel).toBe('Harper')
        expect(gector.chipLabel).toBe('GECToR')
        expect(llm.chipLabel).toBe('✨ AI')
        expect(rule.chipLabel).toBe('rule')
    })
})

describe('buildPanelModel (visible / score / groups / gates)', () => {
    it('hides llm items during the fast phase (visible count drops)', () => {
        const items = [item({ id: 1, model: 'llm' }), item({ id: 2, model: 'harper' })]
        const m = buildPanelModel({ items, text: 'hello', goals: neutralGoals(), phase: 'fast' })
        expect(m.suggestionCount).toBe(1)
        expect(m.visible[0]?.id).toBe(2)
    })

    it('uses the visible-items penalty math to compute the score', () => {
        // 1 spelling (5) + 1 grammar (4) = 9 → score 91 → "excellent" (matches view-model test).
        const items = [
            item({ id: 1, category: 'spelling' }),
            item({ id: 2, category: 'grammar' }),
        ]
        const m = buildPanelModel({ items, text: 'x', goals: neutralGoals(), phase: 'done' })
        expect(m.score).toBe(91)
        expect(m.band).toBe('excellent')
    })

    it('ring color matches BAND_COLOR[band] (consumed, not re-derived)', () => {
        // spell: -5 → 95 → excellent
        const m = buildPanelModel({
            items: [item({ category: 'spelling' })],
            text: 'x',
            goals: neutralGoals(),
            phase: 'done',
        })
        expect(m.ringColor).toBe(BAND_COLOR.excellent)
    })

    it('ring offset follows arcOffset(score) (consumed, not re-derived)', () => {
        // score 60 → ringOffset = 153.9 * 0.4 = 61.56
        // Build: 40-point penalty from four spelling items (5 each).
        const m = buildPanelModel({
            items: [
                item({ id: 1, category: 'spelling' }),
                item({ id: 2, category: 'spelling' }),
                item({ id: 3, category: 'spelling' }),
                item({ id: 4, category: 'spelling' }),
                item({ id: 5, category: 'spelling' }),
                item({ id: 6, category: 'spelling' }),
                item({ id: 7, category: 'spelling' }),
                item({ id: 8, category: 'spelling' }),
            ],
            text: 'x',
            goals: neutralGoals(),
            phase: 'done',
        })
        expect(m.score).toBe(60)
        expect(m.ringOffset).toBeCloseTo(61.56)
    })

    it('ring geometry matches the reference DC (r=24.5, dasharray=153.9)', () => {
        const m = buildPanelModel({ items: [], text: '', goals: neutralGoals(), phase: 'done' })
        expect(m.ringRadius).toBe(24.5)
        expect(m.ringDasharray).toBe(153.9)
    })

    it('insights come from makeInsights(text) — words/readability/readSecs', () => {
        // 16 words across 2 sentences → wps=8 → grade 6 / "Clear". The
        // math lives in view-model.makeInsights; the panel only consumes
        // its result.
        const m = buildPanelModel({
            items: [],
            text: 'one two three four five. six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen.',
            goals: neutralGoals(),
            phase: 'done',
        })
        expect(m.words).toBe(16)
        expect(m.readSecs).toBeGreaterThan(0)
        expect(m.readabilityLabel).toBe('Clear · Gr 6')
    })

    it('insights include the static decorative Tone row', () => {
        // Per the reference DC, the Tone row is a static "● Confident ● Warm"
        // tag — NOT computed from /tone. The model exposes it as a string.
        const m = buildPanelModel({ items: [], text: '', goals: neutralGoals(), phase: 'done' })
        expect(m.toneLabel).toContain('Confident')
        expect(m.toneLabel).toContain('Warm')
    })

    it('groups mirror the visible() filter — not the raw items', () => {
        // Two LLM items + two Harper items + phase=fast → only the Harper
        // items should appear in groups.
        const items = [
            item({ id: 1, model: 'llm', category: 'spelling' }),
            item({ id: 2, model: 'harper', category: 'spelling' }),
            item({ id: 3, model: 'harper', category: 'grammar' }),
        ]
        const m = buildPanelModel({ items, text: '', goals: neutralGoals(), phase: 'fast' })
        expect(m.groups).toHaveLength(2)
        const spellGroup = m.groups.find((g) => g.category === 'spelling')
        expect(spellGroup?.items.map((i) => i.item.id)).toEqual([2])
    })

    it('showHighConfButton = true when 0 < highConf < total', () => {
        // 3 items, 2 with conf 0.95, 1 with conf 0.5 → highConf=2, total=3.
        const items = [
            item({ id: 1, confidence: 0.95 }),
            item({ id: 2, confidence: 0.95 }),
            item({ id: 3, confidence: 0.5 }),
        ]
        const m = buildPanelModel({ items, text: '', goals: neutralGoals(), phase: 'done' })
        expect(m.highConfCount).toBe(2)
        expect(m.suggestionCount).toBe(3)
        expect(m.showHighConfButton).toBe(true)
    })

    it('showHighConfButton = false when highConf === 0 (no button shown)', () => {
        const items = [item({ id: 1, confidence: 0.5 }), item({ id: 2, confidence: 0.5 })]
        const m = buildPanelModel({ items, text: '', goals: neutralGoals(), phase: 'done' })
        expect(m.highConfCount).toBe(0)
        expect(m.showHighConfButton).toBe(false)
    })

    it('showHighConfButton = false when highConf === total (all are high; bulk-accept already covers it)', () => {
        const items = [
            item({ id: 1, confidence: 0.95 }),
            item({ id: 2, confidence: 0.95 }),
        ]
        const m = buildPanelModel({ items, text: '', goals: neutralGoals(), phase: 'done' })
        expect(m.highConfCount).toBe(2)
        expect(m.suggestionCount).toBe(2)
        expect(m.showHighConfButton).toBe(false)
    })

    it('showHighConfButton = false when there are zero visible items', () => {
        const m = buildPanelModel({ items: [], text: '', goals: neutralGoals(), phase: 'done' })
        expect(m.showHighConfButton).toBe(false)
    })

    it('showMutedNote + mutedStyleCount derive from goals + items (informal mutes style)', () => {
        const items = [
            item({ id: 1, category: 'style' }),
            item({ id: 2, category: 'style' }),
            item({ id: 3, category: 'grammar' }),
        ]
        const informal: Goals = { audience: 'general', formality: 'informal' }
        const m = buildPanelModel({ items, text: '', goals: informal, phase: 'done' })
        expect(m.mutedStyleCount).toBe(2)
        expect(m.showMutedNote).toBe(true)
    })

    it('showMutedNote = false under neutrality (no style items hidden, so no note)', () => {
        const items = [item({ id: 1, category: 'style' })]
        const m = buildPanelModel({ items, text: '', goals: neutralGoals(), phase: 'done' })
        expect(m.mutedStyleCount).toBe(0)
        expect(m.showMutedNote).toBe(false)
    })

    it('showStreamingBanner = true ONLY while phase === "fast"', () => {
        const fast = buildPanelModel({ items: [], text: '', goals: neutralGoals(), phase: 'fast' })
        expect(fast.showStreamingBanner).toBe(true)
        const done = buildPanelModel({ items: [], text: '', goals: neutralGoals(), phase: 'done' })
        expect(done.showStreamingBanner).toBe(false)
    })

    it('returns score=100, band=excellent, no groups for an empty visible set', () => {
        const m = buildPanelModel({ items: [], text: '', goals: neutralGoals(), phase: 'done' })
        expect(m.score).toBe(100)
        expect(m.band).toBe('excellent')
        expect(m.groups).toEqual([])
        expect(m.suggestionCount).toBe(0)
    })
})
