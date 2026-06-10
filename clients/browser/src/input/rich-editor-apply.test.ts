// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isFrameworkRichEditor, widenInsertion } from './rich-editor-apply'

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

describe('isFrameworkRichEditor', () => {
    it('returns true when el itself carries data-slate-editor', () => {
        const el = document.createElement('div')
        el.setAttribute('data-slate-editor', '')
        document.body.appendChild(el)
        expect(isFrameworkRichEditor(el)).toBe(true)
    })
    it('returns true when an ancestor carries data-slate-editor (closest)', () => {
        const root = document.createElement('div')
        root.setAttribute('data-slate-editor', '')
        const child = document.createElement('div')
        root.appendChild(child)
        document.body.appendChild(root)
        // the descendant child sees the attr on its ancestor
        expect(isFrameworkRichEditor(child)).toBe(true)
    })
    it('returns true when a descendant carries data-lexical-editor (querySelector)', () => {
        const root = document.createElement('div')
        const inner = document.createElement('div')
        inner.setAttribute('data-lexical-editor', '')
        root.appendChild(inner)
        document.body.appendChild(root)
        // the wrapping contenteditable (the field we apply to) does NOT
        // itself carry the attr — but the editor root sits INSIDE it.
        expect(isFrameworkRichEditor(root)).toBe(true)
    })
    it('returns false on a plain contenteditable (no framework attr anywhere)', () => {
        const el = document.createElement('div')
        el.setAttribute('contenteditable', 'true')
        document.body.appendChild(el)
        expect(isFrameworkRichEditor(el)).toBe(false)
    })
})
