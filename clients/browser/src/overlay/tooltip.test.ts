// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { dismissTooltipsIn, showTooltip } from '@/overlay/tooltip'

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}

const ANCHOR = new DOMRect(100, 100, 40, 16)

describe('showTooltip', () => {
    it('mounts a tooltip with the category label, message and replacement', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            message: 'Subject-verb agreement',
            replacement: 'went',
            original: 'goed',
        })
        const tip = root.querySelector('.gf-tooltip') as HTMLElement
        expect(tip).not.toBeNull()
        expect(tip.getAttribute('role')).toBe('tooltip')
        expect(tip.textContent).toContain('Grammar')
        expect(tip.textContent).toContain('Subject-verb agreement')
        expect(tip.textContent).toContain('went')
        // It is purely informational — no buttons.
        expect(tip.querySelector('button')).toBeNull()
    })

    it('shows a Remove hint for a deletion (empty replacement)', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            message: '',
            replacement: '',
            original: 'has',
        })
        const tip = root.querySelector('.gf-tooltip') as HTMLElement
        expect(tip.textContent).toContain('Remove')
        expect(tip.textContent).toContain('has')
    })

    it('omits the message block when the message is empty', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'spelling',
            message: '',
            replacement: 'their',
            original: 'thier',
        })
        const tip = root.querySelector('.gf-tooltip') as HTMLElement
        expect(tip.querySelector('.gf-tooltip__message')).toBeNull()
        expect(tip.querySelector('.gf-tooltip__replacement')?.textContent).toBe('their')
    })

    it('keeps only one tooltip per root (a new one replaces the prior)', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            message: 'first',
            replacement: 'a',
            original: 'b',
        })
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            message: 'second',
            replacement: 'c',
            original: 'd',
        })
        expect(root.querySelectorAll('.gf-tooltip')).toHaveLength(1)
        expect(root.querySelector('.gf-tooltip')?.textContent).toContain('second')
    })

    it('hide() removes the tooltip and isOpen() reflects state', () => {
        const root = mkRoot()
        const handle = showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            message: 'x',
            replacement: 'y',
            original: 'z',
        })
        expect(handle.isOpen()).toBe(true)
        handle.hide()
        expect(handle.isOpen()).toBe(false)
        expect(root.querySelector('.gf-tooltip')).toBeNull()
    })

    it('escapes HTML in message / replacement (no injection)', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            message: '<img src=x onerror=alert(1)>',
            replacement: '<b>bad</b>',
            original: 'o',
        })
        const tip = root.querySelector('.gf-tooltip') as HTMLElement
        expect(tip.querySelector('img')).toBeNull()
        expect(tip.querySelector('b')).toBeNull()
    })
})

describe('dismissTooltipsIn', () => {
    it('removes every tooltip in the root', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            message: 'x',
            replacement: 'y',
            original: 'z',
        })
        dismissTooltipsIn(root)
        expect(root.querySelector('.gf-tooltip')).toBeNull()
    })
})
