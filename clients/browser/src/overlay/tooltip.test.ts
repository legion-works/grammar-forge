// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { dismissTooltipsIn, showTooltip } from '@/overlay/tooltip'

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}
const ANCHOR = new DOMRect(100, 100, 40, 16)

describe('showTooltip (preview chip)', () => {
    it('mounts a chip with the category dot and red->green diff, no buttons/message', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            diffOriginal: 'was',
            diffCorrected: 'were',
            diffIsDeletion: false,
        })
        const tip = root.querySelector('.gf-tooltip') as HTMLElement
        expect(tip).not.toBeNull()
        expect(tip.getAttribute('role')).toBe('tooltip')
        expect(tip.querySelector('.gf-tooltip__dot')).not.toBeNull()
        expect(tip.querySelector('.gf-diff__old')?.textContent).toBe('was')
        expect(tip.querySelector('.gf-diff__new')?.textContent).toBe('were')
        expect(tip.querySelector('button')).toBeNull()
        expect(tip.querySelector('.gf-tooltip__message')).toBeNull()
    })

    it('shows a "removed" marker for a deletion', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            diffOriginal: 'has',
            diffCorrected: '',
            diffIsDeletion: true,
        })
        const tip = root.querySelector('.gf-tooltip') as HTMLElement
        expect(tip.querySelector('.gf-diff__removed')).not.toBeNull()
        expect(tip.querySelector('.gf-diff__new')).toBeNull()
    })

    it('keeps only one chip per root', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            diffOriginal: 'a',
            diffCorrected: 'b',
            diffIsDeletion: false,
        })
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            diffOriginal: 'c',
            diffCorrected: 'd',
            diffIsDeletion: false,
        })
        expect(root.querySelectorAll('.gf-tooltip')).toHaveLength(1)
        expect(root.querySelector('.gf-diff__new')?.textContent).toBe('d')
    })

    it('hide() removes the chip and isOpen() reflects state', () => {
        const root = mkRoot()
        const h = showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            diffOriginal: 'y',
            diffCorrected: 'z',
            diffIsDeletion: false,
        })
        expect(h.isOpen()).toBe(true)
        h.hide()
        expect(h.isOpen()).toBe(false)
        expect(root.querySelector('.gf-tooltip')).toBeNull()
    })

    it('escapes HTML in the diff (no injection)', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            diffOriginal: '<b>x</b>',
            diffCorrected: '<i>y</i>',
            diffIsDeletion: false,
        })
        const tip = root.querySelector('.gf-tooltip') as HTMLElement
        expect(tip.querySelector('b')).toBeNull()
        expect(tip.querySelector('i')).toBeNull()
    })

    it('dismissTooltipsIn removes every chip', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            diffOriginal: 'y',
            diffCorrected: 'z',
            diffIsDeletion: false,
        })
        dismissTooltipsIn(root)
        expect(root.querySelector('.gf-tooltip')).toBeNull()
    })
})
