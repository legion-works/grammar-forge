import { describe, expect, it } from 'vitest'
import { appendInverseEdit, planUndo, type InverseEdit } from '@/lib/undo'

describe('appendInverseEdit', () => {
    it('records the post-apply span and shifts prior (higher) inverses by the new delta', () => {
        // Text "aaa bbb ccc": apply at [8,11) "ccc"->"C" first (desc order), then [0,3) "aaa"->"AAAA".
        let batch: InverseEdit[] = []
        batch = appendInverseEdit(batch, {
            start: 8,
            end: 11,
            replacement: 'C',
            original: 'ccc',
        })
        expect(batch).toEqual([{ start: 8, end: 9, applied: 'C', original: 'ccc' }])
        batch = appendInverseEdit(batch, {
            start: 0,
            end: 3,
            replacement: 'AAAA',
            original: 'aaa',
        })
        // "aaa"->"AAAA" is +1: the earlier-recorded higher span shifts right by 1.
        expect(batch).toEqual([
            { start: 9, end: 10, applied: 'C', original: 'ccc' },
            { start: 0, end: 4, applied: 'AAAA', original: 'aaa' },
        ])
    })
})

describe('planUndo', () => {
    it('emits applyFix ops highest-start first, stale-guarded against live text', () => {
        const live = 'AAAA bbb C'
        const batch: InverseEdit[] = [
            { start: 9, end: 10, applied: 'C', original: 'ccc' },
            { start: 0, end: 4, applied: 'AAAA', original: 'aaa' },
        ]
        const ops = planUndo(live, batch)
        expect(ops).toEqual([
            { span: { start: 9, end: 10 }, replacement: 'ccc' },
            { span: { start: 0, end: 4 }, replacement: 'aaa' },
        ])
        expect(ops[0]!.span.start).toBeGreaterThan(ops[1]!.span.start)
    })

    it('skips inverses whose live slice no longer matches what was applied', () => {
        const live = 'AAAA bbb X' // user typed over the "C"
        const batch: InverseEdit[] = [
            { start: 9, end: 10, applied: 'C', original: 'ccc' },
            { start: 0, end: 4, applied: 'AAAA', original: 'aaa' },
        ]
        const ops = planUndo(live, batch)
        expect(ops).toEqual([{ span: { start: 0, end: 4 }, replacement: 'aaa' }])
    })
})
