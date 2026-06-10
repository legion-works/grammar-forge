import { describe, expect, it } from 'vitest'
import { widenInsertion } from './slate-apply'

describe('widenInsertion', () => {
    it('passes non-collapsed spans through unchanged', () => {
        const r = widenInsertion('abcdef', { start: 1, end: 3 }, 'X')
        expect(r).toEqual({ span: { start: 1, end: 3 }, replacement: 'X' })
    })
    it('widens a mid-text insertion onto the preceding char', () => {
        // insert "." at end-of-word: replace "e" -> "e."
        const r = widenInsertion('apple', { start: 5, end: 5 }, '.')
        expect(r).toEqual({ span: { start: 4, end: 5 }, replacement: 'e.' })
    })
    it('widens an offset-0 insertion onto the following char', () => {
        const r = widenInsertion('bc', { start: 0, end: 0 }, 'a')
        expect(r).toEqual({ span: { start: 0, end: 1 }, replacement: 'ab' })
    })
    it('keeps surrogate pairs whole when widening left', () => {
        const text = 'a\u{1F600}' // 'a' + emoji (2 code units), insert after emoji
        const r = widenInsertion(text, { start: 3, end: 3 }, '!')
        expect(r.span).toEqual({ start: 1, end: 3 })
        expect(r.replacement).toBe('\u{1F600}!')
    })
    it('keeps surrogate pairs whole when widening right at offset 0', () => {
        const text = '\u{1F600}b'
        const r = widenInsertion(text, { start: 0, end: 0 }, '!')
        expect(r.span).toEqual({ start: 0, end: 2 })
        expect(r.replacement).toBe('!\u{1F600}')
    })
    it('returns collapsed span unchanged on empty text', () => {
        const r = widenInsertion('', { start: 0, end: 0 }, 'x')
        expect(r).toEqual({ span: { start: 0, end: 0 }, replacement: 'x' })
    })
})
