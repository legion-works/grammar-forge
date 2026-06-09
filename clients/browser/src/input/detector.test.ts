// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isEditableElement } from '@/input/detector'

const mk = (tag: string, attrs: Record<string, string> = {}): HTMLElement => {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    document.body.appendChild(el)
    return el
}

describe('isEditableElement', () => {
    it('accepts <textarea>', () => {
        expect(isEditableElement(mk('textarea'))).toBe(true)
    })

    it('accepts <input type="text">', () => {
        expect(isEditableElement(mk('input', { type: 'text' }))).toBe(true)
    })

    it('accepts <input> with no type attribute (HTML default is "text")', () => {
        // Per HTML spec, an <input> with no type attribute defaults to type=text.
        const el = document.createElement('input')
        document.body.appendChild(el)
        expect(isEditableElement(el)).toBe(true)
    })

    it('accepts <input type="search"> and "email", "url", "tel"', () => {
        expect(isEditableElement(mk('input', { type: 'search' }))).toBe(true)
        expect(isEditableElement(mk('input', { type: 'email' }))).toBe(true)
        expect(isEditableElement(mk('input', { type: 'url' }))).toBe(true)
        expect(isEditableElement(mk('input', { type: 'tel' }))).toBe(true)
    })

    it('rejects <input type="password">', () => {
        expect(isEditableElement(mk('input', { type: 'password' }))).toBe(false)
    })

    it('rejects <input type="checkbox"> and "submit"', () => {
        expect(isEditableElement(mk('input', { type: 'checkbox' }))).toBe(false)
        expect(isEditableElement(mk('input', { type: 'submit' }))).toBe(false)
    })

    it('rejects <input type="text" readonly>', () => {
        expect(isEditableElement(mk('input', { type: 'text', readonly: '' }))).toBe(false)
    })

    it('rejects <input type="text" disabled>', () => {
        expect(isEditableElement(mk('input', { type: 'text', disabled: '' }))).toBe(false)
    })

    it('rejects <textarea readonly>', () => {
        expect(isEditableElement(mk('textarea', { readonly: '' }))).toBe(false)
    })

    it('rejects <textarea disabled>', () => {
        expect(isEditableElement(mk('textarea', { disabled: '' }))).toBe(false)
    })

    it('accepts <div contenteditable>', () => {
        expect(isEditableElement(mk('div', { contenteditable: 'true' }))).toBe(true)
    })

    it('rejects <div contenteditable="false">', () => {
        expect(isEditableElement(mk('div', { contenteditable: 'false' }))).toBe(false)
    })

    it('rejects <div contenteditable="FALSE"> (case-insensitive false)', () => {
        expect(isEditableElement(mk('div', { contenteditable: 'FALSE' }))).toBe(false)
        expect(isEditableElement(mk('div', { contenteditable: 'False' }))).toBe(false)
    })

    it('accepts <div contenteditable=""> (empty = true, the HTML5 idiom)', () => {
        expect(isEditableElement(mk('div', { contenteditable: '' }))).toBe(true)
    })

    it('rejects <div contenteditable="inherit"> (only the host decides; not a host itself)', () => {
        // "inherit" means: same as parent. If the parent isn't editable, this
        // isn't editable. We don't try to resolve inheritance for our purposes
        // — an inherit-only element is not a host.
        expect(isEditableElement(mk('div', { contenteditable: 'inherit' }))).toBe(false)
    })

    it('accepts the OUTER host when contenteditable elements are nested', () => {
        // Spec §6: one overlay per editor, anchored to the outermost host.
        // A nested contenteditable is part of the outer host's content; it
        // must not be reported as a separate field.
        const outer = mk('div', { contenteditable: 'true' })
        const inner = document.createElement('div')
        inner.setAttribute('contenteditable', 'true')
        outer.appendChild(inner)
        const p = document.createElement('p')
        p.textContent = 'hi'
        inner.appendChild(p)

        expect(isEditableElement(outer)).toBe(true)
        expect(isEditableElement(inner)).toBe(false)
        expect(isEditableElement(p)).toBe(false) // non-editable descendant of host
    })

    it('rejects a contenteditable nested inside a contenteditable even when inner has no "false" attribute', () => {
        // Sanity: the rejection is "ancestor is editable" not "attribute says false".
        const outer = mk('div', { contenteditable: 'true' })
        const inner = document.createElement('div')
        inner.setAttribute('contenteditable', 'plaintext-only')
        outer.appendChild(inner)
        expect(isEditableElement(outer)).toBe(true)
        expect(isEditableElement(inner)).toBe(false)
    })

    it('accepts <div contenteditable="plaintext-only">', () => {
        expect(isEditableElement(mk('div', { contenteditable: 'plaintext-only' }))).toBe(true)
    })

    it('accepts <div role="textbox">', () => {
        expect(isEditableElement(mk('div', { role: 'textbox' }))).toBe(true)
    })

    it('accepts <div g_editable="true"> (Google Docs/Sites/Sheets hack)', () => {
        expect(isEditableElement(mk('div', { g_editable: 'true' }))).toBe(true)
    })

    it('accepts <div role="textbox" aria-readonly="true"> (readonly a11y, not the HTML attr)', () => {
        // aria-readonly is a hint, not a write-protection; we don't gate on it.
        // Real readonly protection is `readOnly` JS property / `readonly` HTML attr.
        expect(isEditableElement(mk('div', { role: 'textbox', 'aria-readonly': 'true' }))).toBe(
            true,
        )
    })

    it('rejects <div data-grammarforge-ignore> (opt-out even on editable)', () => {
        expect(isEditableElement(mk('textarea', { 'data-grammarforge-ignore': 'true' }))).toBe(
            false,
        )
        expect(
            isEditableElement(
                mk('div', { contenteditable: 'true', 'data-grammarforge-ignore': '' }),
            ),
        ).toBe(false)
    })

    it('rejects null', () => {
        expect(isEditableElement(null)).toBe(false)
    })

    it('rejects non-HTMLElements', () => {
        // document is not an HTMLElement
        expect(isEditableElement(document as unknown as HTMLElement)).toBe(false)
    })
})
