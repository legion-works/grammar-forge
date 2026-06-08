import { describe, expect, it } from 'vitest'
import { byteToCodeUnit, verifyByteSpan } from '@/api/offset'

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
