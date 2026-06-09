import { describe, expect, it } from 'vitest'
import { wordLevelDiff } from '@/lib/word-diff'

describe('wordLevelDiff', () => {
    it('expands a character-level edit to the whole word ("as"->"ere" => was->were)', () => {
        // "we was watching" — the bridge edit is the char span "as" (4..6) -> "ere"
        const text = 'we was watching'
        const d = wordLevelDiff(text, 4, 6, 'ere')
        expect(d.original).toBe('was')
        expect(d.corrected).toBe('were')
        expect(d.isDeletion).toBe(false)
    })

    it('handles a whole-word replacement (are->is)', () => {
        const text = 'He are happy'
        // "are" is [3,6)
        const d = wordLevelDiff(text, 3, 6, 'is')
        expect(d.original).toBe('are')
        expect(d.corrected).toBe('is')
    })

    it('expands a single-char edit ("o" removed => too->to)', () => {
        const text = 'go too far'
        // delete the second 'o' of "too" at [5,6)
        const d = wordLevelDiff(text, 5, 6, '')
        expect(d.original).toBe('too')
        expect(d.corrected).toBe('to')
        expect(d.isDeletion).toBe(false)
    })

    it('flags a deletion when the whole word is removed', () => {
        const text = 'the the cat'
        // delete "the " (one of the duplicates) at [4,8)
        const d = wordLevelDiff(text, 4, 8, '')
        // window expands to the word(s) the span covers; corrected is empty
        expect(d.isDeletion).toBe(true)
    })

    it('keeps punctuation/contractions whole (not split on apostrophe)', () => {
        const text = 'I dont know'
        // "dont" [2,6) -> "don't"
        const d = wordLevelDiff(text, 2, 6, "don't")
        expect(d.original).toBe('dont')
        expect(d.corrected).toBe("don't")
    })

    it('clamps an out-of-range span without throwing (degenerate, dropped upstream)', () => {
        const text = 'short'
        // Invalid spans are dropped by verifyByteSpan before reaching here; this
        // only asserts robustness — no throw, and the replacement is present.
        const d = wordLevelDiff(text, 100, 200, 'x')
        expect(d.corrected).toContain('x')
    })

    it('edit at the start of the text expands rightward only', () => {
        const text = 'teh cat'
        // "teh" [0,3) -> "the"
        const d = wordLevelDiff(text, 0, 3, 'the')
        expect(d.original).toBe('teh')
        expect(d.corrected).toBe('the')
    })
})
