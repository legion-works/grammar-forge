import { describe, expect, it } from 'vitest'
import { splitDictionaryTokens } from './dictionary'

describe('splitDictionaryTokens', () => {
    it('returns [] for empty input', () => {
        expect(splitDictionaryTokens('')).toEqual([])
    })
    it('returns [] for whitespace-only input', () => {
        expect(splitDictionaryTokens('   \n\t  ')).toEqual([])
    })
    it('returns the single word when no whitespace is present', () => {
        expect(splitDictionaryTokens('foo')).toEqual(['foo'])
    })
    it('splits on any whitespace run', () => {
        expect(splitDictionaryTokens('foo bar  baz')).toEqual(['foo', 'bar', 'baz'])
    })
    it('drops empty fragments from leading/trailing whitespace', () => {
        expect(splitDictionaryTokens('  foo bar  ')).toEqual(['foo', 'bar'])
    })
    it('dedupes repeats while preserving first-occurrence order', () => {
        expect(splitDictionaryTokens('foo bar foo baz bar')).toEqual(['foo', 'bar', 'baz'])
    })
    it('handles tabs and newlines as whitespace', () => {
        expect(splitDictionaryTokens('foo\tbar\nbaz')).toEqual(['foo', 'bar', 'baz'])
    })
})
