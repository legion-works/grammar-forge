// Unit tests for the content-script pipeline. Verifies the verifyByteSpan drop
// + deriveCategory attach path in isolation — no network, no DOM.

import { describe, expect, it } from 'vitest'
import type { BridgeSuggestion, Category, CorrectResponse } from '@/api/types'
import { isSpanStillValid, runCheck, tallyByCategory } from '@/lib/pipeline'

function suggestion(over: Partial<BridgeSuggestion>): BridgeSuggestion {
    return {
        span: { start: 0, end: 1 },
        replacement: 'the',
        model: 'harper',
        ...over,
    }
}

function correctResponse(suggestions: BridgeSuggestion[]): CorrectResponse {
    return { original: 'teh', suggestions, score: 90 }
}

describe('runCheck', () => {
    it('attaches code-unit offsets, the derived category, and a non-empty replacements list', async () => {
        const text = 'teh quick brown fox'
        const suggestions: BridgeSuggestion[] = [
            suggestion({ span: { start: 0, end: 3 }, replacement: 'the', model: 'harper' }),
        ]
        const res = await runCheck(text, {
            correct: async () => correctResponse(suggestions),
        })
        expect(res.items).toHaveLength(1)
        const it0 = res.items[0]!
        expect(it0.cuStart).toBe(0)
        expect(it0.cuEnd).toBe(3)
        expect(it0.original).toBe('teh')
        expect(it0.replacements).toEqual(['the'])
        // No wire category + harper model → deriveCategory falls back to 'grammar'
        expect(it0.category).toBe<Category>('grammar')
        expect(it0.byteSpan).toEqual({ start: 0, end: 3 })
        expect(res.dropped).toBe(0)
    })

    it('preserves the wire `category` over a derived one', async () => {
        const text = 'teh quick brown fox'
        const res = await runCheck(text, {
            correct: async () =>
                correctResponse([
                    suggestion({
                        span: { start: 0, end: 3 },
                        replacement: 'the',
                        model: 'harper',
                        category: 'spelling',
                    }),
                ]),
        })
        expect(res.items[0]!.category).toBe<Category>('spelling')
    })

    it('uses replacements[] when present, otherwise wraps the primary replacement', async () => {
        const text = 'teh quick brown fox'
        const res = await runCheck(text, {
            correct: async () =>
                correctResponse([
                    suggestion({
                        span: { start: 0, end: 3 },
                        replacement: 'the',
                        replacements: ['the', 'teh'],
                        model: 'harper',
                    }),
                ]),
        })
        expect(res.items[0]!.replacements).toEqual(['the', 'teh'])
    })

    it('drops suggestions whose byte span fails verification, increments dropped count, warns', async () => {
        const text = 'teh quick brown fox'
        // span {start:1, end:3} lands mid-codepoint? No — "teh" all ASCII, the byte
        // span is actually valid for ASCII. Use a verify stub that rejects the
        // span to exercise the drop path deterministically.
        const res = await runCheck(text, {
            correct: async () =>
                correctResponse([suggestion({ span: { start: 0, end: 3 }, replacement: 'the' })]),
            verify: () => null,
        })
        expect(res.items).toHaveLength(0)
        expect(res.dropped).toBe(1)
    })

    it('does not call deriveCategory for a dropped suggestion', async () => {
        const text = 'teh quick brown fox'
        const derive = (): Category => {
            throw new Error('derive must not run for dropped suggestions')
        }
        const res = await runCheck(text, {
            correct: async () =>
                correctResponse([suggestion({ span: { start: 0, end: 3 }, replacement: 'the' })]),
            verify: () => null,
            derive,
        })
        // Implicit assertion: runCheck did not throw because derive was
        // never invoked on the dropped suggestion.
        expect(res.dropped).toBe(1)
        expect(res.items).toHaveLength(0)
    })

    it('handles multibyte text correctly (é = 2 bytes / 1 code unit)', async () => {
        const text = 'éclair'
        // bytes 0..2 cover the é — verifyByteSpan must return {start:0, end:1}
        const res = await runCheck(text, {
            correct: async () =>
                correctResponse([
                    suggestion({
                        span: { start: 0, end: 2 },
                        replacement: 'É',
                        model: 'harper',
                        category: 'spelling',
                    }),
                ]),
        })
        expect(res.items).toHaveLength(1)
        const it0 = res.items[0]!
        expect(it0.cuStart).toBe(0)
        expect(it0.cuEnd).toBe(1)
        expect(it0.original).toBe('é')
    })

    it('forwards the bridge model and ruleId onto the renderable item', async () => {
        const res = await runCheck('teh quick', {
            correct: async () =>
                correctResponse([
                    suggestion({
                        span: { start: 0, end: 3 },
                        replacement: 'the',
                        model: 'gector',
                        ruleId: 'gector:R::VERB',
                    }),
                ]),
        })
        expect(res.items[0]!.model).toBe('gector')
        expect(res.items[0]!.ruleId).toBe('gector:R::VERB')
    })

    it('returns an empty result when the bridge reports no suggestions', async () => {
        const res = await runCheck('clean text', {
            correct: async () => correctResponse([]),
        })
        expect(res.items).toEqual([])
        expect(res.dropped).toBe(0)
    })
})

describe('tallyByCategory', () => {
    it('aggregates items by category', async () => {
        const res = await runCheck('teh teh teh', {
            correct: async () =>
                correctResponse([
                    suggestion({
                        span: { start: 0, end: 3 },
                        replacement: 'the',
                        category: 'spelling',
                    }),
                    suggestion({
                        span: { start: 4, end: 7 },
                        replacement: 'the',
                        category: 'spelling',
                    }),
                    suggestion({
                        span: { start: 8, end: 11 },
                        replacement: 'the',
                        category: 'spelling',
                    }),
                ]),
        })
        expect(tallyByCategory(res.items)).toEqual({ spelling: 3 })
    })

    it('returns {} for an empty item list', () => {
        expect(tallyByCategory([])).toEqual({})
    })
})

describe('isSpanStillValid', () => {
    it('returns true when the live text still matches the original slice', () => {
        const text = 'the quick brown fox'
        const item = { cuStart: 4, cuEnd: 9, original: 'quick' }
        expect(isSpanStillValid(text, item)).toBe(true)
    })

    it('returns false when the user typed ahead and the original word shifted', () => {
        // The user typed "very " between "the " and "quick", shifting the
        // suggestion's slice left by 5 code units. The cuStart/cuEnd are
        // now stale — applying the fix would corrupt the new word.
        const text = 'the very quick brown fox'
        const item = { cuStart: 4, cuEnd: 9, original: 'quick' }
        expect(isSpanStillValid(text, item)).toBe(false)
    })

    it('returns false when the user accepted a different fix and the word changed', () => {
        const text = 'the fast brown fox'
        const item = { cuStart: 4, cuEnd: 9, original: 'quick' }
        expect(isSpanStillValid(text, item)).toBe(false)
    })

    it('returns false when the slice was deleted (out-of-range)', () => {
        const text = 'the  brown fox'
        const item = { cuStart: 4, cuEnd: 9, original: 'quick' }
        expect(isSpanStillValid(text, item)).toBe(false)
    })

    it('returns false for negative or inverted spans (defensive)', () => {
        expect(isSpanStillValid('abc', { cuStart: -1, cuEnd: 2, original: 'a' })).toBe(false)
        expect(isSpanStillValid('abc', { cuStart: 2, cuEnd: 1, original: 'a' })).toBe(false)
    })

    it('returns true for an empty original at a matching empty slice (zero-width)', () => {
        const text = 'hello world'
        const item = { cuStart: 5, cuEnd: 5, original: '' }
        expect(isSpanStillValid(text, item)).toBe(true)
    })
})
