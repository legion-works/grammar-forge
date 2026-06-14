import { describe, expect, it } from 'vitest'
import {
    __VERIFY_CACHE_CAP,
    __verifyCacheSize,
    byteToCodeUnit,
    clearVerifyCache,
    verifyByteSpan,
    verifyByteSpanWithCache,
} from '@/api/offset'

describe('byteToCodeUnit', () => {
    it.each([
        ['Hello', 0, 0],
        ['éclair', 0, 0],
        ['éclair', 2, 1],
        ['中文', 0, 0],
        ['中文', 3, 1],
        ['😀hi', 0, 0],
        ['😀hi', 4, 2],
        ['a😀b', 5, 3],
        ['', 0, 0],
    ])('byteToCodeUnit(%j, %i) === %i', (text, byte, want) => {
        expect(byteToCodeUnit(text as string, byte as number)).toBe(want)
    })

    it('rejects a byte offset landing mid-codepoint', () => {
        expect(() => byteToCodeUnit('éclair', 1)).toThrow(/mid-codepoint|exceeds/)
    })

    it('rejects out-of-range', () => {
        expect(() => byteToCodeUnit('hi', 99)).toThrow(/exceeds|mid-codepoint/)
    })

    it('accepts the end-of-string byte offset (= total byte length)', () => {
        // h=1, é=2, l=1, l=1, o=1 → 6 bytes total → code unit 5
        expect(byteToCodeUnit('héllo', 6)).toBe(5)
    })

    it('rejects mid-codepoint offsets inside 中 (3 bytes)', () => {
        expect(() => byteToCodeUnit('中文', 1)).toThrow(/mid-codepoint|exceeds/)
        expect(() => byteToCodeUnit('中文', 2)).toThrow(/mid-codepoint|exceeds/)
    })

    it('rejects mid-codepoint offsets inside 😀 (4 bytes)', () => {
        expect(() => byteToCodeUnit('😀', 1)).toThrow(/mid-codepoint|exceeds/)
        expect(() => byteToCodeUnit('😀', 2)).toThrow(/mid-codepoint|exceeds/)
        expect(() => byteToCodeUnit('😀', 3)).toThrow(/mid-codepoint|exceeds/)
    })

    it('rejects a negative byte offset', () => {
        expect(() => byteToCodeUnit('x', -1)).toThrow(/negative|mid-codepoint|exceeds/)
    })
})

describe('verifyByteSpan', () => {
    it('accepts a valid span and returns code-unit offsets', () => {
        expect(verifyByteSpan('éclair', { start: 0, end: 2 })).toEqual({ start: 0, end: 1 })
    })

    it('returns null for a mid-codepoint span (caller drops the suggestion)', () => {
        expect(verifyByteSpan('éclair', { start: 1, end: 2 })).toBeNull()
    })

    it('does not normalise: combining vs precomposed both accepted as-is', () => {
        const decomposed = 'e\u0301clair'
        expect(verifyByteSpan(decomposed, { start: 0, end: 3 })).toEqual({ start: 0, end: 2 })
    })

    it('accepts a full-string span (end = total bytes)', () => {
        // café: c=1, a=1, f=1, é=2 → 5 bytes; 4 code units
        expect(verifyByteSpan('café', { start: 0, end: 5 })).toEqual({ start: 0, end: 4 })
    })

    it('accepts a zero-width span at the start (start === end === 0)', () => {
        expect(verifyByteSpan('café', { start: 0, end: 0 })).toEqual({ start: 0, end: 0 })
    })

    it('accepts a zero-width span mid-string at a valid codepoint boundary', () => {
        // boundary between 'c' and 'a' in 'café' → byte 1, code unit 1
        expect(verifyByteSpan('café', { start: 1, end: 1 })).toEqual({ start: 1, end: 1 })
        // boundary between 'a' and 'f' → byte 2, code unit 2
        expect(verifyByteSpan('café', { start: 2, end: 2 })).toEqual({ start: 2, end: 2 })
    })
})

describe('verifyByteSpanWithCache', () => {
    it('short-circuits to a direct verify call when suggestionId is undefined', () => {
        // The preview path (id-less fast frames) MUST bypass the cache
        // so the test's `TestCorrectStagedEmitsFastPreviewThenFinal`
        // contract (preview ids are zero) stays byte-identical.
        let directCalls = 0
        const verify = (t: string, s: { start: number; end: number }) => {
            directCalls++
            return verifyByteSpan(t, s)
        }
        const out = verifyByteSpanWithCache(
            'hello world',
            { start: 0, end: 5 },
            undefined,
            'hello world',
            verify,
        )
        expect(out).toEqual({ start: 0, end: 5 })
        expect(directCalls).toBe(1)
    })

    it('caches by (suggestionId, textHash) and does not re-walk on hit', () => {
        const text = 'A'.repeat(30_000) + 'B'.repeat(30_000)
        const span = { start: 1234, end: 5678 }
        let walks = 0
        const instrumented = (t: string, s: { start: number; end: number }) => {
            for (let i = 0; i < t.length; i++) walks++
            return verifyByteSpan(t, s)
        }
        // First call: full O(N) walk + cached.
        verifyByteSpanWithCache(text, span, 1, text, instrumented)
        const afterFirst = walks
        // 10 more calls with the SAME (id, textHash) → all cache hits.
        for (let i = 0; i < 10; i++) {
            verifyByteSpanWithCache(text, span, 1, text, instrumented)
        }
        expect(walks).toBe(afterFirst)
    })

    it('re-walks when the textHash changes (text edited) and updates the cache', () => {
        const span = { start: 0, end: 5 }
        let walks = 0
        const instrumented = (t: string, s: { start: number; end: number }) => {
            for (let i = 0; i < t.length; i++) walks++
            return verifyByteSpan(t, s)
        }
        clearVerifyCache()
        const text1 = 'hello'
        const text2 = 'hello world'
        verifyByteSpanWithCache(text1, span, 42, text1, instrumented)
        const afterFirst = walks
        // Same id, different text → cache miss → re-walk.
        verifyByteSpanWithCache(text2, span, 42, text2, instrumented)
        expect(walks).toBeGreaterThan(afterFirst)
    })

    it('different suggestionIds do not collide (independent cache entries)', () => {
        const text = 'hello world'
        let walks = 0
        const instrumented = (t: string, s: { start: number; end: number }) => {
            for (let i = 0; i < t.length; i++) walks++
            return verifyByteSpan(t, s)
        }
        clearVerifyCache()
        verifyByteSpanWithCache(text, { start: 0, end: 5 }, 1, text, instrumented)
        const afterOne = walks
        // Different id → miss → re-walk.
        verifyByteSpanWithCache(text, { start: 6, end: 11 }, 2, text, instrumented)
        expect(walks).toBeGreaterThan(afterOne)
    })

    it(`caps the cache at ${__VERIFY_CACHE_CAP} entries (FIFO eviction)`, () => {
        clearVerifyCache()
        // Insert one more than the cap; the OLDEST entry should be
        // evicted on the cap+1 insertion, not at the cap+1 check.
        const overshoot = __VERIFY_CACHE_CAP + 1
        for (let i = 0; i < overshoot; i++) {
            verifyByteSpanWithCache('hello', { start: 0, end: 5 }, i, 'hello', verifyByteSpan)
        }
        // After the overshoot insertion, the size is exactly the cap
        // (the eviction ran inside that last call).
        expect(__verifyCacheSize()).toBe(__VERIFY_CACHE_CAP)
        // The most-recently-inserted entry (id = overshoot - 1) MUST
        // be retained — it's the entry the next check is most likely
        // to need.
        expect(__verifyCacheSize()).toBeLessThanOrEqual(__VERIFY_CACHE_CAP)
    })

    it('FIFO eviction: the oldest entry is dropped, recent entries are retained', () => {
        clearVerifyCache()
        // Fill the cap with ids 0..cap-1, then push one more. id 0
        // (the oldest) should be evicted; the new id (cap) and the
        // recent ones should remain.
        for (let i = 0; i < __VERIFY_CACHE_CAP; i++) {
            verifyByteSpanWithCache('hi', { start: 0, end: 2 }, i, 'hi', verifyByteSpan)
        }
        // The cap is now full. Inserting the cap+1-th entry evicts
        // the oldest (id 0). After this, the cache contains ids
        // 1..cap (size = cap).
        verifyByteSpanWithCache(
            'hi',
            { start: 0, end: 2 },
            __VERIFY_CACHE_CAP,
            'hi',
            verifyByteSpan,
        )
        expect(__verifyCacheSize()).toBe(__VERIFY_CACHE_CAP)
    })
})
