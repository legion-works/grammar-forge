// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createUnderlineLayer, renderUnderlines } from '@/overlay/underline'

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
        // grammar underline colour is #ca8a04 -> %23ca8a04 in the data URI.
        expect(bg).toContain('%23ca8a04')
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

describe('createUnderlineLayer', () => {
    it('reconciles a flat pool: one node per (item,rect), reused across calls', () => {
        const root = mkRoot()
        const layer = createUnderlineLayer(root)
        layer.reconcile([
            { rect: new DOMRect(10, 20, 100, 16), category: 'spelling' },
            { rect: new DOMRect(10, 40, 80, 16), category: 'grammar' },
        ])
        const first = Array.from(root.querySelectorAll('.gf-underline'))
        expect(first).toHaveLength(2)
        // second reconcile with the SAME count reuses the SAME nodes (no churn)
        layer.reconcile([
            { rect: new DOMRect(15, 20, 90, 16), category: 'spelling' },
            { rect: new DOMRect(10, 40, 80, 16), category: 'grammar' },
        ])
        const second = Array.from(root.querySelectorAll('.gf-underline'))
        expect(second).toHaveLength(2)
        expect(second[0]).toBe(first[0]) // same node object, repositioned in place
        expect((second[0] as HTMLElement).style.left).toBe('15px')
    })

    it('grows and shrinks the pool to match the spec count', () => {
        const root = mkRoot()
        const layer = createUnderlineLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling' },
            { rect: new DOMRect(0, 20, 50, 16), category: 'spelling' },
            { rect: new DOMRect(0, 40, 50, 16), category: 'spelling' },
        ])
        expect(root.querySelectorAll('.gf-underline')).toHaveLength(3)
        layer.reconcile([{ rect: new DOMRect(0, 0, 50, 16), category: 'spelling' }])
        expect(root.querySelectorAll('.gf-underline')).toHaveLength(1)
    })

    it('updates class + baked colour when a node changes category', () => {
        const root = mkRoot()
        const layer = createUnderlineLayer(root)
        layer.reconcile([{ rect: new DOMRect(0, 0, 50, 16), category: 'spelling' }])
        const node = root.querySelector('.gf-underline') as HTMLElement
        expect(node.classList.contains('gf-underline--wavy')).toBe(true)
        layer.reconcile([{ rect: new DOMRect(0, 0, 50, 16), category: 'typography' }])
        expect(node.classList.contains('gf-underline--solid')).toBe(true)
        expect(node.classList.contains('gf-underline--wavy')).toBe(false)
    })

    it('hides (display:none) zero-area rects without removing the pooled node', () => {
        const root = mkRoot()
        const layer = createUnderlineLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 0, 0), category: 'spelling' },
            { rect: new DOMRect(0, 20, 50, 16), category: 'spelling' },
        ])
        const nodes = root.querySelectorAll('.gf-underline')
        expect(nodes).toHaveLength(2)
        expect((nodes[0] as HTMLElement).style.display).toBe('none')
        expect((nodes[1] as HTMLElement).style.display).toBe('')
    })

    it('destroy() removes every pooled node', () => {
        const root = mkRoot()
        const layer = createUnderlineLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling' },
            { rect: new DOMRect(0, 20, 50, 16), category: 'grammar' },
        ])
        expect(root.querySelectorAll('.gf-underline')).toHaveLength(2)
        layer.destroy()
        expect(root.querySelectorAll('.gf-underline')).toHaveLength(0)
    })
})
