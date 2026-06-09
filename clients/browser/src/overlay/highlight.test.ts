// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createHighlightLayer } from '@/overlay/highlight'

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}

describe('createHighlightLayer', () => {
    it('creates one .gf-highlight node per spec, sized as full rects', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(10, 20, 100, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(10, 40, 80, 16), category: 'grammar', itemIndex: 1 },
        ])
        const nodes = root.querySelectorAll('.gf-highlight')
        expect(nodes).toHaveLength(2)
        const a = nodes[0] as HTMLElement
        const b = nodes[1] as HTMLElement
        // full-rect sizing — not a 2px bar
        expect(a.style.left).toBe('10px')
        expect(a.style.top).toBe('20px')
        expect(a.style.width).toBe('100px')
        expect(a.style.height).toBe('16px')
        expect(b.style.left).toBe('10px')
        expect(b.style.top).toBe('40px')
        expect(b.style.width).toBe('80px')
        expect(b.style.height).toBe('16px')
    })

    it('sets --gf-hl to the category colour and data-item to the itemIndex', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([{ rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 7 }])
        const node = root.querySelector('.gf-highlight') as HTMLElement
        // spelling underline colour from CATEGORY_META
        expect(node.style.getPropertyValue('--gf-hl')).toBe('#dc2626')
        expect(node.dataset.item).toBe('7')
    })

    it('hides (display:none) zero-area rects without removing the pooled node', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 0, 0), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'spelling', itemIndex: 0 },
        ])
        const nodes = root.querySelectorAll('.gf-highlight')
        expect(nodes).toHaveLength(2)
        expect((nodes[0] as HTMLElement).style.display).toBe('none')
        expect((nodes[1] as HTMLElement).style.display).toBe('')
    })

    it('reuses the same pooled nodes when reconcile is called with the same count', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(10, 20, 100, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(10, 40, 80, 16), category: 'grammar', itemIndex: 1 },
        ])
        const first = Array.from(root.querySelectorAll('.gf-highlight'))
        layer.reconcile([
            { rect: new DOMRect(15, 20, 90, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(10, 40, 80, 16), category: 'grammar', itemIndex: 1 },
        ])
        const second = Array.from(root.querySelectorAll('.gf-highlight'))
        expect(second).toHaveLength(2)
        expect(second[0]).toBe(first[0])
        expect((second[0] as HTMLElement).style.left).toBe('15px')
    })

    it('grows and shrinks the pool to match the spec count', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 40, 50, 16), category: 'spelling', itemIndex: 0 },
        ])
        expect(root.querySelectorAll('.gf-highlight')).toHaveLength(3)
        layer.reconcile([{ rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 }])
        expect(root.querySelectorAll('.gf-highlight')).toHaveLength(1)
    })

    it('repositions in place and re-tints when a node changes category', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([{ rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 }])
        const node = root.querySelector('.gf-highlight') as HTMLElement
        expect(node.style.getPropertyValue('--gf-hl')).toBe('#dc2626')
        layer.reconcile([
            { rect: new DOMRect(5, 10, 50, 16), category: 'typography', itemIndex: 0 },
        ])
        expect(node.style.getPropertyValue('--gf-hl')).toBe('#6b7280')
        expect(node.style.left).toBe('5px')
        expect(node.style.top).toBe('10px')
    })

    it('reapplies the last state to every node after a reconcile (no flicker)', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.setState({ focused: true, hoverItemIndex: null })
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'spelling', itemIndex: 1 },
        ])
        const nodes = root.querySelectorAll('.gf-highlight')
        for (const n of nodes) {
            expect((n as HTMLElement).classList.contains('gf-highlight--focus')).toBe(true)
        }
    })

    it('setState({focused:true}) adds gf-highlight--focus to every node', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'spelling', itemIndex: 1 },
        ])
        layer.setState({ focused: true, hoverItemIndex: null })
        const nodes = root.querySelectorAll('.gf-highlight')
        for (const n of nodes) {
            expect((n as HTMLElement).classList.contains('gf-highlight--focus')).toBe(true)
        }
        layer.setState({ focused: false, hoverItemIndex: null })
        for (const n of nodes) {
            expect((n as HTMLElement).classList.contains('gf-highlight--focus')).toBe(false)
        }
    })

    it('setState({hoverItemIndex:i}) adds gf-highlight--hover only to the matching data-item', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'spelling', itemIndex: 1 },
            { rect: new DOMRect(0, 40, 50, 16), category: 'spelling', itemIndex: 2 },
        ])
        layer.setState({ focused: false, hoverItemIndex: 1 })
        const nodes = Array.from(root.querySelectorAll('.gf-highlight')) as HTMLElement[]
        expect(nodes[0]!.classList.contains('gf-highlight--hover')).toBe(false)
        expect(nodes[1]!.classList.contains('gf-highlight--hover')).toBe(true)
        expect(nodes[2]!.classList.contains('gf-highlight--hover')).toBe(false)
    })

    it('destroy() removes every pooled node', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'grammar', itemIndex: 1 },
        ])
        expect(root.querySelectorAll('.gf-highlight')).toHaveLength(2)
        layer.destroy()
        expect(root.querySelectorAll('.gf-highlight')).toHaveLength(0)
    })

    it('nodes are decorative only (aria-hidden, no role or tabindex)', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([{ rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 }])
        const node = root.querySelector('.gf-highlight') as HTMLElement
        expect(node.getAttribute('aria-hidden')).toBe('true')
        expect(node.getAttribute('role')).toBeNull()
        expect(node.getAttribute('tabindex')).toBeNull()
    })
})
