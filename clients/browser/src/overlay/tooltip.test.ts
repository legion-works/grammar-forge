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
    it('mounts a tooltip with the category label, message and red->green diff', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            message: 'Subject-verb agreement',
            diffOriginal: 'was',
            diffCorrected: 'were',
            diffIsDeletion: false,
        })
        const tip = root.querySelector('.gf-tooltip') as HTMLElement
        expect(tip).not.toBeNull()
        expect(tip.getAttribute('role')).toBe('tooltip')
        expect(tip.textContent).toContain('Grammar')
        expect(tip.textContent).toContain('Subject-verb agreement')
        // diff: old (red) + new (green)
        expect(tip.querySelector('.gf-diff__old')?.textContent).toBe('was')
        expect(tip.querySelector('.gf-diff__new')?.textContent).toBe('were')
        // It is purely informational — no buttons.
        expect(tip.querySelector('button')).toBeNull()
    })

    it('shows a "removed" marker for a deletion (no green side)', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            message: '',
            diffOriginal: 'has',
            diffCorrected: '',
            diffIsDeletion: true,
        })
        const tip = root.querySelector('.gf-tooltip') as HTMLElement
        expect(tip.querySelector('.gf-diff__old')?.textContent).toBe('has')
        expect(tip.querySelector('.gf-diff__removed')).not.toBeNull()
        expect(tip.querySelector('.gf-diff__new')).toBeNull()
    })

    it('omits the message block when the message is empty', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'spelling',
            message: '',
            diffOriginal: 'thier',
            diffCorrected: 'their',
            diffIsDeletion: false,
        })
        const tip = root.querySelector('.gf-tooltip') as HTMLElement
        expect(tip.querySelector('.gf-tooltip__message')).toBeNull()
        expect(tip.querySelector('.gf-diff__new')?.textContent).toBe('their')
    })

    it('keeps only one tooltip per root (a new one replaces the prior)', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            message: 'first',
            diffOriginal: 'a',
            diffCorrected: 'b',
            diffIsDeletion: false,
        })
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            message: 'second',
            diffOriginal: 'c',
            diffCorrected: 'd',
            diffIsDeletion: false,
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
            diffOriginal: 'y',
            diffCorrected: 'z',
            diffIsDeletion: false,
        })
        expect(handle.isOpen()).toBe(true)
        handle.hide()
        expect(handle.isOpen()).toBe(false)
        expect(root.querySelector('.gf-tooltip')).toBeNull()
    })

    it('escapes HTML in message / diff (no injection)', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            message: '<img src=x onerror=alert(1)>',
            diffOriginal: '<b>bad</b>',
            diffCorrected: '<i>x</i>',
            diffIsDeletion: false,
        })
        const tip = root.querySelector('.gf-tooltip') as HTMLElement
        expect(tip.querySelector('img')).toBeNull()
        expect(tip.querySelector('b')).toBeNull()
        expect(tip.querySelector('i')).toBeNull()
    })
})

describe('dismissTooltipsIn', () => {
    it('removes every tooltip in the root', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            message: 'x',
            diffOriginal: 'y',
            diffCorrected: 'z',
            diffIsDeletion: false,
        })
        dismissTooltipsIn(root)
        expect(root.querySelector('.gf-tooltip')).toBeNull()
    })
})
