// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
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
            onClick: vi.fn<(e: MouseEvent) => void>(),
        })
        expect(handle.nodes).toHaveLength(2)
        for (const node of handle.nodes) {
            expect(node.classList.contains('gf-underline')).toBe(true)
            // spelling = wavy
            expect(node.classList.contains('gf-underline--wavy')).toBe(true)
            expect(node.style.color).toBeTruthy()
            expect(node.getAttribute('role')).toBe('button')
        }
    })

    it('skips zero-width / zero-height rects', () => {
        const root = mkRoot()
        const handle = renderUnderlines(root, {
            rects: [new DOMRect(0, 0, 0, 0), new DOMRect(10, 20, 100, 16)],
            category: 'grammar',
            onClick: vi.fn<(e: MouseEvent) => void>(),
        })
        expect(handle.nodes).toHaveLength(1)
    })

    it('picks the dotted variant for style category', () => {
        const root = mkRoot()
        const handle = renderUnderlines(root, {
            rects: [new DOMRect(10, 20, 100, 16)],
            category: 'style',
            onClick: vi.fn<(e: MouseEvent) => void>(),
        })
        expect(handle.nodes[0]?.classList.contains('gf-underline--dotted')).toBe(true)
    })

    it('picks the solid variant for typography category', () => {
        const root = mkRoot()
        const handle = renderUnderlines(root, {
            rects: [new DOMRect(10, 20, 100, 16)],
            category: 'typography',
            onClick: vi.fn<(e: MouseEvent) => void>(),
        })
        expect(handle.nodes[0]?.classList.contains('gf-underline--solid')).toBe(true)
    })

    it('mousedown does not steal focus from the field (preventDefault + stopPropagation)', () => {
        const root = mkRoot()
        const onClick = vi.fn<(e: MouseEvent) => void>()
        const handle = renderUnderlines(root, {
            rects: [new DOMRect(10, 20, 100, 16)],
            category: 'spelling',
            onClick,
        })
        const node = handle.nodes[0]!
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
        const prevented = !node.dispatchEvent(ev)
        expect(prevented).toBe(true)
        expect(onClick).not.toHaveBeenCalled()
    })

    it('click fires onClick exactly once', () => {
        const root = mkRoot()
        const onClick = vi.fn<(e: MouseEvent) => void>()
        const handle = renderUnderlines(root, {
            rects: [new DOMRect(10, 20, 100, 16)],
            category: 'spelling',
            onClick,
        })
        const node = handle.nodes[0]!
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onClick).toHaveBeenCalledOnce()
    })

    it('Enter / Space keyboard also fires onClick', () => {
        const root = mkRoot()
        const onClick = vi.fn<(e: MouseEvent) => void>()
        const handle = renderUnderlines(root, {
            rects: [new DOMRect(10, 20, 100, 16)],
            category: 'grammar',
            onClick,
        })
        const node = handle.nodes[0]!
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        node.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
        expect(onClick).toHaveBeenCalledTimes(2)
    })

    it('destroy() removes every node it owns', () => {
        const root = mkRoot()
        const handle = renderUnderlines(root, {
            rects: [new DOMRect(10, 20, 100, 16), new DOMRect(10, 40, 100, 16)],
            category: 'punctuation',
            onClick: vi.fn<(e: MouseEvent) => void>(),
        })
        expect(root.querySelectorAll('.gf-underline')).toHaveLength(2)
        handle.destroy()
        expect(root.querySelectorAll('.gf-underline')).toHaveLength(0)
    })
})
