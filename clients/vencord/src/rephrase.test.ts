// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { resolveRephraseScope } from './rephrase'

describe('resolveRephraseScope', () => {
    it('returns the selection when it matches the target element', () => {
        const el = document.createElement('div')
        document.body.appendChild(el)
        const found = { el, text: 'sel', span: { start: 0, end: 3 } }
        const got = resolveRephraseScope(el, found)
        expect(got).toEqual({ el, text: 'sel', span: { start: 0, end: 3 } })
    })
    it('returns null when no selection and the field is empty', () => {
        const el = document.createElement('div')
        el.innerHTML = ''
        document.body.appendChild(el)
        expect(resolveRephraseScope(el, null)).toBeNull()
    })
    it('returns null when no selection and the field is whitespace-only', () => {
        const el = document.createElement('div')
        el.innerHTML = '   \n  '
        document.body.appendChild(el)
        expect(resolveRephraseScope(el, null)).toBeNull()
    })
    it('falls back to the whole field when the selection is in a different element', () => {
        const target = document.createElement('div')
        target.innerHTML = 'whole text'
        const other = document.createElement('div')
        document.body.appendChild(target)
        document.body.appendChild(other)
        const found = { el: other, text: 'x', span: { start: 0, end: 1 } }
        expect(resolveRephraseScope(target, found)).toEqual({
            el: target,
            text: 'whole text',
            span: { start: 0, end: 10 },
        })
    })
    it('whole-field scope span covers every character (start=0, end=text.length)', () => {
        const target = document.createElement('div')
        target.innerHTML = 'abcdef'
        document.body.appendChild(target)
        expect(resolveRephraseScope(target, null)).toEqual({
            el: target,
            text: 'abcdef',
            span: { start: 0, end: 6 },
        })
    })
})
