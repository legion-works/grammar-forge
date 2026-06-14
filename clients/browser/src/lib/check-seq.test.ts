import { describe, expect, it } from 'vitest'
import { nextCheckSeq } from './check-seq'

describe('nextCheckSeq', () => {
    it('returns strictly increasing values', () => {
        const a = nextCheckSeq()
        const b = nextCheckSeq()
        const c = nextCheckSeq()
        expect(b).toBeGreaterThan(a)
        expect(c).toBeGreaterThan(b)
    })
    it('never returns 0', () => {
        // 10 consecutive calls: not one of them is 0.
        const seen = new Set<number>()
        for (let i = 0; i < 10; i++) seen.add(nextCheckSeq())
        expect(seen.has(0)).toBe(false)
    })
    it('never repeats a value', () => {
        const seen = new Set<number>()
        for (let i = 0; i < 100; i++) seen.add(nextCheckSeq())
        expect(seen.size).toBe(100)
    })
})
