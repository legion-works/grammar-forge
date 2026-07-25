// Unit tests for the content-script pipeline. Verifies the verifyByteSpan drop
// + deriveCategory attach path in isolation — no network, no DOM.

import { describe, expect, it } from 'vitest'
import type { BridgeSuggestion, Category, CorrectResponse } from '@/api/types'
import { clearVerifyCache, verifyByteSpan } from '@/api/offset'
import { buildRenderableItems, isSpanStillValid, runCheck, tallyByCategory } from '@/lib/pipeline'
import { widenInsertion } from '@/input/rich-editor-apply'

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

describe('buildRenderableItems', () => {
    const res = {
        original: 'I has a cat',
        suggestions: [
            {
                span: { start: 2, end: 5 },
                replacement: 'have',
                model: 'gector' as const,
            },
        ],
        score: 90,
    }

    it('marks items preview when asked', () => {
        const { items } = buildRenderableItems('I has a cat', res, {}, { preview: true })
        expect(items).toHaveLength(1)
        expect(items[0]?.preview).toBe(true)
        expect(items[0]?.id).toBeUndefined()
    })

    it('defaults to non-preview', () => {
        const { items } = buildRenderableItems('I has a cat', res, {})
        expect(items[0]?.preview).toBeUndefined()
    })

    it('runCheck still works through the async path', async () => {
        const { items } = await runCheck('I has a cat', { correct: async () => res })
        expect(items).toHaveLength(1)
        expect(items[0]?.preview).toBeUndefined()
    })

    it('drops suggestions whose span contains a newline (start position)', () => {
        // span [1, 2) on "a\nb" = "\n" — the slice itself contains a \n.
        const res = {
            original: 'a\nb',
            suggestions: [
                { span: { start: 1, end: 2 }, replacement: 'B', model: 'gector' as const },
            ],
            score: 90,
        }
        const { items, dropped } = buildRenderableItems('a\nb', res, {})
        expect(items).toEqual([])
        expect(dropped).toBe(1)
    })

    it('keeps a suggestion on a word that ends a line (newline AFTER the span)', () => {
        // The legit in-line "has→have" case in "I has\na apple": span [2, 5)
        // = "has"; the \n is at position 5 (immediately AFTER the span, NOT
        // inside it). The earlier `slice(cu.start, cu.end + 1)` over-dropped
        // this; the new contract drops ONLY suggestions whose span CONTAINS
        // a \n. The bridge C2 fix is the root cause; this client belt is
        // the regression guard.
        const res = {
            original: 'I has\na apple',
            suggestions: [
                { span: { start: 2, end: 5 }, replacement: 'have', model: 'gector' as const },
            ],
            score: 90,
        }
        const { items, dropped } = buildRenderableItems('I has\na apple', res, {})
        expect(items).toHaveLength(1)
        expect(items[0]?.original).toBe('has')
        expect(dropped).toBe(0)
    })

    it('drops suggestions whose span contains a newline (crosses a \\n internally)', () => {
        // [0, 3) on "a\nbc" = "a\nb" — the slice contains a \n.
        const res = {
            original: 'a\nbc',
            suggestions: [
                { span: { start: 0, end: 3 }, replacement: 'A BC', model: 'gector' as const },
            ],
            score: 90,
        }
        const { items, dropped } = buildRenderableItems('a\nbc', res, {})
        expect(items).toEqual([])
        expect(dropped).toBe(1)
    })

    it('keeps suggestions whose span is fully on one line (no-newline control)', () => {
        const res = {
            original: 'teh quick',
            suggestions: [
                { span: { start: 0, end: 3 }, replacement: 'the', model: 'gector' as const },
            ],
            score: 90,
        }
        const { items, dropped } = buildRenderableItems('teh quick', res, {})
        expect(items).toHaveLength(1)
        expect(dropped).toBe(0)
    })

    it('collapses duplicate zero-width items before an apply-all batch', () => {
        const text = 'The quick brown fox jump over the lazy dog'
        const res: CorrectResponse = {
            original: text,
            suggestions: [
                { span: { start: 24, end: 24 }, replacement: 'ed', model: 'llm' },
                {
                    span: { start: 24, end: 24 },
                    replacement: 'ed',
                    model: 'llm',
                    category: 'style',
                },
            ],
            score: 90,
        }

        const { items } = buildRenderableItems(text, res)
        let applied = text
        for (const item of [...items].sort((a, b) => b.cuStart - a.cuStart)) {
            const widened = widenInsertion(applied, { start: item.cuStart, end: item.cuEnd }, item.replacements[0] ?? '')
            applied = applied.slice(0, widened.span.start) + widened.replacement + applied.slice(widened.span.end)
        }

        expect(items).toHaveLength(1)
        expect(applied).toBe('The quick brown fox jumped over the lazy dog')
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

describe('buildRenderableItems — P1 verifyByteSpanWithCache', () => {
    it('O(K) verify calls on second run of identical text + suggestions', () => {
        // Same text + same suggestion ids → second run is a full cache
        // hit for every suggestion. The verify mock is the only way
        // to count calls; the production code path is opaque.
        const text = 'I has a cat and I has a dog too'
        const res: CorrectResponse = {
            original: text,
            suggestions: [
                {
                    id: 1,
                    span: { start: 2, end: 5 },
                    replacement: 'have',
                    model: 'gector',
                },
                {
                    id: 2,
                    span: { start: 17, end: 20 },
                    replacement: 'have',
                    model: 'gector',
                },
            ],
            score: 90,
        }
        clearVerifyCache()
        let verifyCalls = 0
        const verify = (t: string, s: { start: number; end: number }) => {
            verifyCalls++
            return verifyByteSpan(t, s)
        }
        // First run: 2 verify calls (cache populated, one entry per id).
        buildRenderableItems(text, res, { verify })
        expect(verifyCalls).toBe(2)
        // Second run: same text + same ids → 0 additional verify calls.
        buildRenderableItems(text, res, { verify })
        expect(verifyCalls).toBe(2)
    })

    it('re-verifies when the text changes (cache miss on hash mismatch)', () => {
        const res: CorrectResponse = {
            original: 'I has a cat',
            suggestions: [
                { id: 7, span: { start: 2, end: 5 }, replacement: 'have', model: 'gector' },
            ],
            score: 90,
        }
        clearVerifyCache()
        let verifyCalls = 0
        const verify = (t: string, s: { start: number; end: number }) => {
            verifyCalls++
            return verifyByteSpan(t, s)
        }
        buildRenderableItems('I has a cat', res, { verify })
        const afterFirst = verifyCalls
        // Different text → cache miss → re-verify.
        buildRenderableItems('I has a dog', res, { verify })
        expect(verifyCalls).toBe(afterFirst + 1)
    })

    it('preview path (id-less fast frames) bypasses the cache', () => {
        // The bridge's preview frames carry no id (s.id is undefined).
        // The cache short-circuits to a direct verify call so the
        // existing "fast preview then final" contract stays
        // byte-identical and no leaked entries pollute the cache.
        const res: CorrectResponse = {
            original: 'I has a cat',
            suggestions: [{ span: { start: 2, end: 5 }, replacement: 'have', model: 'gector' }],
            score: 90,
        }
        clearVerifyCache()
        let verifyCalls = 0
        const verify = (t: string, s: { start: number; end: number }) => {
            verifyCalls++
            return verifyByteSpan(t, s)
        }
        buildRenderableItems('I has a cat', res, { verify })
        buildRenderableItems('I has a cat', res, { verify })
        // No id → every call goes through verify directly. 2 runs ×
        // 1 suggestion = 2 calls (not 1, like the id-keyed case).
        expect(verifyCalls).toBe(2)
    })
})
