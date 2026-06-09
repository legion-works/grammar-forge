// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderUnderlines } from '@/overlay/underline'

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}

describe('renderUnderlines', () => {
    it('creates one node per rect, styled per category', () => {
        const root = mkRoot()
        const handle = renderUnderlines(root, {
            rects: [new DOMRect(10, 20, 100, 16), new DOMRect(10, 40, 80, 16)],
            category: 'spelling',
        })
        expect(handle.nodes).toHaveLength(2)
        for (const node of handle.nodes) {
            expect(node.classList.contains('gf-underline')).toBe(true)
            // spelling = wavy
            expect(node.classList.contains('gf-underline--wavy')).toBe(true)
            expect(node.style.color).toBeTruthy()
        }
    })

    it('underline nodes are decorative only (aria-hidden, no button role)', () => {
        const root = mkRoot()
        const handle = renderUnderlines(root, {
            rects: [new DOMRect(10, 20, 100, 16)],
            category: 'spelling',
        })
        const node = handle.nodes[0]!
        expect(node.getAttribute('aria-hidden')).toBe('true')
        expect(node.getAttribute('role')).toBeNull()
        expect(node.getAttribute('tabindex')).toBeNull()
    })

    it('bakes the category colour into the wavy SVG (no currentColor, which is invisible in a data-URI background)', () => {
        const root = mkRoot()
        const handle = renderUnderlines(root, {
            rects: [new DOMRect(10, 20, 100, 16)],
            category: 'grammar',
        })
        const bg = handle.nodes[0]!.style.backgroundImage
        expect(bg).toContain('data:image/svg+xml')
        // grammar underline colour is #d97706 -> %23d97706 in the data URI.
        expect(bg).toContain('%23d97706')
        expect(bg).not.toContain('currentColor')
    })

    it('skips zero-width / zero-height rects', () => {
        const root = mkRoot()
        const handle = renderUnderlines(root, {
            rects: [new DOMRect(0, 0, 0, 0), new DOMRect(10, 20, 100, 16)],
            category: 'grammar',
        })
        expect(handle.nodes).toHaveLength(1)
    })

    it('picks the dotted variant for style category', () => {
        const root = mkRoot()
        const handle = renderUnderlines(root, {
            rects: [new DOMRect(10, 20, 100, 16)],
            category: 'style',
        })
        expect(handle.nodes[0]?.classList.contains('gf-underline--dotted')).toBe(true)
    })

    it('picks the solid variant for typography category', () => {
        const root = mkRoot()
        const handle = renderUnderlines(root, {
            rects: [new DOMRect(10, 20, 100, 16)],
            category: 'typography',
        })
        expect(handle.nodes[0]?.classList.contains('gf-underline--solid')).toBe(true)
    })

    it('destroy() removes every node it owns', () => {
        const root = mkRoot()
        const handle = renderUnderlines(root, {
            rects: [new DOMRect(10, 20, 100, 16), new DOMRect(10, 40, 100, 16)],
            category: 'punctuation',
        })
        expect(root.querySelectorAll('.gf-underline')).toHaveLength(2)
        handle.destroy()
        expect(root.querySelectorAll('.gf-underline')).toHaveLength(0)
    })
})
