// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { resolveRephraseScope, type RephraseScope } from './rephrase'

const makeScope = (over: Partial<RephraseScope> & { el: HTMLElement }): RephraseScope => ({
    text: '',
    span: { start: 0, end: 0 },
    rect: new DOMRect(),
    ...over,
})

describe('resolveRephraseScope', () => {
    const el = document.createElement('div')

    it('uses the selection text+span when the selection is in the target element', () => {
        const found = makeScope({ el, text: 'sel text', span: { start: 5, end: 14 } })
        const getWhole = vi.fn<() => string>(() => 'whole')
        expect(resolveRephraseScope(el, found, getWhole)).toEqual({
            text: 'sel text',
            span: { start: 5, end: 14 },
        })
        expect(getWhole).not.toHaveBeenCalled()
    })

    it('falls back to the whole field when no selection is found', () => {
        const getWhole = vi.fn<() => string>(() => 'whole text here')
        expect(resolveRephraseScope(el, null, getWhole)).toEqual({
            text: 'whole text here',
            span: { start: 0, end: 15 },
        })
    })

    it('returns null when no selection AND the whole field is whitespace-only', () => {
        expect(resolveRephraseScope(el, null, () => '   \n  ')).toBeNull()
    })

    it('returns null when no selection AND the whole field is empty', () => {
        expect(resolveRephraseScope(el, null, () => '')).toBeNull()
    })

    it('falls back to whole field when the selection is in a different element', () => {
        const other = document.createElement('div')
        const found = makeScope({ el: other, text: 'x', span: { start: 0, end: 1 } })
        expect(resolveRephraseScope(el, found, () => 'whole')).toEqual({
            text: 'whole',
            span: { start: 0, end: 5 },
        })
    })
})
