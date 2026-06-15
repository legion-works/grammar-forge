// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createHighlightLayer } from '@/overlay/highlight'

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}

describe('createHighlightLayer', () => {
    it('creates one .gf-u node per spec, sized as full rects, with category modifier', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(10, 20, 100, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(10, 40, 80, 16), category: 'grammar', itemIndex: 1 },
        ])
        const nodes = root.querySelectorAll('.gf-u')
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
        const node = root.querySelector('.gf-u') as HTMLElement
        // spelling tint colour from CATEGORY_META
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
        const nodes = root.querySelectorAll('.gf-u')
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
        const first = Array.from(root.querySelectorAll('.gf-u'))
        layer.reconcile([
            { rect: new DOMRect(15, 20, 90, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(10, 40, 80, 16), category: 'grammar', itemIndex: 1 },
        ])
        const second = Array.from(root.querySelectorAll('.gf-u'))
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
        expect(root.querySelectorAll('.gf-u')).toHaveLength(3)
        layer.reconcile([{ rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 }])
        expect(root.querySelectorAll('.gf-u')).toHaveLength(1)
    })

    it('repositions in place and re-tints when a node changes category', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([{ rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 }])
        const node = root.querySelector('.gf-u') as HTMLElement
        expect(node.style.getPropertyValue('--gf-hl')).toBe('#dc2626')
        layer.reconcile([
            { rect: new DOMRect(5, 10, 50, 16), category: 'typography', itemIndex: 0 },
        ])
        expect(node.style.getPropertyValue('--gf-hl')).toBe('#6b7280')
        expect(node.style.left).toBe('5px')
        expect(node.style.top).toBe('10px')
    })

    it('reapplies the last state to every node after a reconcile (no flicker)', () => {
        // Tint is hover/active-only: focused:true alone does NOT add .is-on.
        // Use hoverItemIndex to verify the state is re-applied after reconcile.
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.setState({ focused: true, hoverItemIndex: 0 })
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'spelling', itemIndex: 1 },
        ])
        const nodes = root.querySelectorAll('.gf-u')
        // item 0 is hovered → .is-on; item 1 is not → no .is-on
        expect((nodes[0] as HTMLElement).classList.contains('is-on')).toBe(true)
        expect((nodes[1] as HTMLElement).classList.contains('is-on')).toBe(false)
    })

    it('setState({focused:true}) does NOT add is-on to nodes (tint is hover/active-only per DC)', () => {
        // Bug-fix: the old applyState used `state.focused || hoverItemIndex === idx`
        // which tinted ALL flagged words when the field was focused. The DC
        // specifies tint ONLY on hover/active (hoverItemIndex match), not on
        // field focus. The focused flag is kept for the native-highlight path
        // but must not tint overlay nodes.
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'spelling', itemIndex: 1 },
        ])
        layer.setState({ focused: true, hoverItemIndex: null })
        const nodes = root.querySelectorAll('.gf-u')
        // focused:true alone must NOT add .is-on (tint is hover/active-only)
        for (const n of nodes) {
            expect((n as HTMLElement).classList.contains('is-on')).toBe(false)
        }
        // hoverItemIndex=0 adds .is-on only to item 0
        layer.setState({ focused: true, hoverItemIndex: 0 })
        expect((nodes[0] as HTMLElement).classList.contains('is-on')).toBe(true)
        expect((nodes[1] as HTMLElement).classList.contains('is-on')).toBe(false)
        // clearing hover removes .is-on even while focused
        layer.setState({ focused: true, hoverItemIndex: null })
        for (const n of nodes) {
            expect((n as HTMLElement).classList.contains('is-on')).toBe(false)
        }
    })

    it('setState({hoverItemIndex:i}) adds is-on only to the matching data-item', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'spelling', itemIndex: 1 },
            { rect: new DOMRect(0, 40, 50, 16), category: 'spelling', itemIndex: 2 },
        ])
        layer.setState({ focused: false, hoverItemIndex: 1 })
        const nodes = Array.from(root.querySelectorAll('.gf-u')) as HTMLElement[]
        expect(nodes[0]!.classList.contains('is-on')).toBe(false)
        expect(nodes[1]!.classList.contains('is-on')).toBe(true)
        expect(nodes[2]!.classList.contains('is-on')).toBe(false)
    })

    it('setState hover change only re-toggles the changed nodes', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'spelling', itemIndex: 1 },
        ])
        layer.setState({ focused: false, hoverItemIndex: 0 })
        const n0 = root.querySelectorAll('.gf-u')[0] as HTMLElement
        const n1 = root.querySelectorAll('.gf-u')[1] as HTMLElement
        expect(n0.classList.contains('is-on')).toBe(true)
        expect(n1.classList.contains('is-on')).toBe(false)
        layer.setState({ focused: false, hoverItemIndex: 1 })
        expect(n0.classList.contains('is-on')).toBe(false)
        expect(n1.classList.contains('is-on')).toBe(true)
    })

    it('destroy() removes every pooled node', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'grammar', itemIndex: 1 },
        ])
        expect(root.querySelectorAll('.gf-u')).toHaveLength(2)
        layer.destroy()
        expect(root.querySelectorAll('.gf-u')).toHaveLength(0)
    })

    it('nodes are decorative only (aria-hidden, no role or tabindex)', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([{ rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 }])
        const node = root.querySelector('.gf-u') as HTMLElement
        expect(node.getAttribute('aria-hidden')).toBe('true')
        expect(node.getAttribute('role')).toBeNull()
        expect(node.getAttribute('tabindex')).toBeNull()
    })

    it('flashApplied adds the applied class to the matching item nodes', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'grammar', itemIndex: 1 },
        ])
        layer.flashApplied(0)
        const nodes = Array.from(root.querySelectorAll('.gf-u')) as HTMLElement[]
        expect(nodes[0]!.classList.contains('gf-u--applied')).toBe(true)
        expect(nodes[1]!.classList.contains('gf-u--applied')).toBe(false)
    })

    it('flashApplied is a no-op for an index with no node', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([{ rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 }])
        expect(() => layer.flashApplied(5)).not.toThrow()
    })

    it('updateItem changes only the targeted pooled node', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'grammar', itemIndex: 1 },
            { rect: new DOMRect(0, 40, 50, 16), category: 'typography', itemIndex: 2 },
        ])
        const before = Array.from(root.querySelectorAll('.gf-u')) as HTMLElement[]
        const originalB = before[1]!.getAttribute('aria-hidden')
        layer.updateItem(1, { rect: new DOMRect(5, 25, 60, 16), category: 'style' })
        const after = Array.from(root.querySelectorAll('.gf-u')) as HTMLElement[]
        // Same pooled nodes (no rebuild).
        expect(after).toEqual(before)
        // Item 0 untouched.
        expect((after[0] as HTMLElement).style.left).toBe('0px')
        expect((after[0] as HTMLElement).style.getPropertyValue('--gf-hl')).toBe('#dc2626')
        // Item 1 restyled in place.
        expect((after[1] as HTMLElement).style.left).toBe('5px')
        expect((after[1] as HTMLElement).style.top).toBe('25px')
        expect((after[1] as HTMLElement).style.width).toBe('60px')
        expect((after[1] as HTMLElement).style.getPropertyValue('--gf-hl')).toBe('#7c3aed')
        expect(after[1]!.getAttribute('aria-hidden')).toBe(originalB)
        // Item 2 untouched.
        expect((after[2] as HTMLElement).style.left).toBe('0px')
        expect((after[2] as HTMLElement).style.top).toBe('40px')
    })

    it('updateItem applies the last state to the touched node (no flicker)', () => {
        // Tint is hover/active-only. Move the hover from 0 to 1; the
        // touched node (1) must keep .is-on after the rect update.
        // Node 0 loses .is-on because it is no longer hovered.
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.setState({ focused: true, hoverItemIndex: 0 })
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'spelling', itemIndex: 1 },
        ])
        layer.setState({ focused: true, hoverItemIndex: 1 })
        layer.updateItem(1, { rect: new DOMRect(0, 25, 50, 16), category: 'spelling' })
        const nodes = Array.from(root.querySelectorAll('.gf-u')) as HTMLElement[]
        // Only item 1 is hovered → only item 1 has .is-on.
        expect(nodes[0]!.classList.contains('is-on')).toBe(false)
        expect(nodes[1]!.classList.contains('is-on')).toBe(true)
    })

    it('updateItem is a no-op for an itemIndex past the end', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([{ rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 }])
        // Plan deviation: the plan's literal omitted `category` from the args,
        // which is a type error (Omit<HighlightSpec, 'itemIndex'> requires both
        // rect + category). The contract is still "no-op" — the test asserts
        // the call doesn't throw.
        expect(() =>
            layer.updateItem(5, { rect: new DOMRect(0, 0, 10, 10), category: 'spelling' }),
        ).not.toThrow()
    })

    it('clearItem hides only the targeted pooled node (display:none)', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'grammar', itemIndex: 1 },
        ])
        const before = Array.from(root.querySelectorAll('.gf-u')) as HTMLElement[]
        layer.clearItem(1)
        const after = Array.from(root.querySelectorAll('.gf-u')) as HTMLElement[]
        // Same pooled nodes (no rebuild / no removal).
        expect(after).toEqual(before)
        // Item 1 hidden.
        expect((after[1] as HTMLElement).style.display).toBe('none')
        // Item 0 still visible.
        expect((after[0] as HTMLElement).style.display).toBe('')
    })

    it('clearItem is a no-op for an itemIndex past the end', () => {
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([{ rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 }])
        expect(() => layer.clearItem(5)).not.toThrow()
    })

    it('updateItem restyles every rect-node of a multi-rect item, leaves other items alone', () => {
        // Multi-rect item (e.g. a wrapped word produced TWO getClientRects()).
        // The pool is indexed by RECT, not by item, so item 0 owns pool[0] +
        // pool[1] and item 1 owns pool[2]. The old `pool[itemIndex]` impl
        // would only touch pool[0] — leaving the second item-0 rect stale
        // and missing item 1 entirely. The fix looks up by data-item.
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 40, 50, 16), category: 'grammar', itemIndex: 1 },
        ])
        layer.updateItem(0, { rect: new DOMRect(5, 25, 60, 16), category: 'style' })
        const nodes = Array.from(root.querySelectorAll('.gf-u')) as HTMLElement[]
        // Both item-0 rect-nodes restyled.
        expect(nodes[0]!.style.left).toBe('5px')
        expect(nodes[0]!.style.top).toBe('25px')
        expect(nodes[0]!.style.getPropertyValue('--gf-hl')).toBe('#7c3aed')
        expect(nodes[1]!.style.left).toBe('5px')
        expect(nodes[1]!.style.top).toBe('25px')
        expect(nodes[1]!.style.getPropertyValue('--gf-hl')).toBe('#7c3aed')
        // Item-1 node untouched.
        expect(nodes[2]!.style.left).toBe('0px')
        expect(nodes[2]!.style.top).toBe('40px')
        expect(nodes[2]!.style.getPropertyValue('--gf-hl')).toBe('#ca8a04')
    })

    it('clearItem hides every rect-node of a multi-rect item, leaves other items alone', () => {
        // Same multi-rect setup as the updateItem test above. The old
        // `pool[itemIndex]` impl would only hide pool[0], leaking the
        // second item-0 rect (still visible) and never touching item 1.
        const root = mkRoot()
        const layer = createHighlightLayer(root)
        layer.reconcile([
            { rect: new DOMRect(0, 0, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 20, 50, 16), category: 'spelling', itemIndex: 0 },
            { rect: new DOMRect(0, 40, 50, 16), category: 'grammar', itemIndex: 1 },
        ])
        layer.clearItem(0)
        const nodes = Array.from(root.querySelectorAll('.gf-u')) as HTMLElement[]
        // Both item-0 rect-nodes hidden.
        expect(nodes[0]!.style.display).toBe('none')
        expect(nodes[1]!.style.display).toBe('none')
        // Item-1 node still visible.
        expect(nodes[2]!.style.display).toBe('')
    })
})
