// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { dismissTooltipsIn, showTooltip } from '@/overlay/tooltip'

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}
const ANCHOR = new DOMRect(100, 100, 40, 16)

describe('showTooltip (preview pill)', () => {
    it('mounts a .gf-tip pill with the category dot and red->green diff, no buttons/message', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            diffOriginal: 'was',
            diffCorrected: 'were',
            diffIsDeletion: false,
        })
        const tip = root.querySelector('.gf-tip') as HTMLElement
        expect(tip).not.toBeNull()
        expect(tip.getAttribute('role')).toBe('tooltip')
        // W1-2: class is .gf-tip, not the old .gf-tooltip
        expect(tip.classList.contains('gf-tip')).toBe(true)
        // The category dot is a .gf-tip__dot
        expect(tip.querySelector('.gf-tip__dot')).not.toBeNull()
        // The diff is the shared .gf-diff fragment (gf-diff__old/new)
        expect(tip.querySelector('.gf-diff__old')?.textContent).toBe('was')
        expect(tip.querySelector('.gf-diff__new')?.textContent).toBe('were')
        // The downward caret is rendered as the last child
        expect(tip.querySelector('.gf-tip__tail')).not.toBeNull()
        // No buttons, no message.
        expect(tip.querySelector('button')).toBeNull()
        expect(tip.querySelector('.gf-tip__message')).toBeNull()
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
        const tip = root.querySelector('.gf-tip') as HTMLElement
        expect(tip.querySelector('.gf-diff__removed')).not.toBeNull()
        expect(tip.querySelector('.gf-diff__new')).toBeNull()
    })

    it('keeps only one pill per root', () => {
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
        expect(root.querySelectorAll('.gf-tip')).toHaveLength(1)
        expect(root.querySelector('.gf-diff__new')?.textContent).toBe('d')
    })

    it('hide() removes the pill and isOpen() reflects state', () => {
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
        expect(root.querySelector('.gf-tip')).toBeNull()
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
        const tip = root.querySelector('.gf-tip') as HTMLElement
        expect(tip.querySelector('b')).toBeNull()
        expect(tip.querySelector('i')).toBeNull()
    })

    it('dismissTooltipsIn removes every pill', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            diffOriginal: 'y',
            diffCorrected: 'z',
            diffIsDeletion: false,
        })
        dismissTooltipsIn(root)
        expect(root.querySelector('.gf-tip')).toBeNull()
    })

    it('uses the supplied anchorRect (no DOM re-measurement)', () => {
        // MEASURE-BEFORE-RERENDER invariant: the orchestrator must measure
        // the word's rect BEFORE re-rendering the underline overlay, and
        // pass that rect in. showTooltip must NOT call getBoundingClientRect
        // itself — it just uses the passed-in value. We assert the pill
        // is positioned at the supplied anchor's left.
        const root = mkRoot()
        const customAnchor = new DOMRect(247, 333, 60, 18)
        showTooltip(root, {
            anchorRect: customAnchor,
            category: 'spelling',
            diffOriginal: 'x',
            diffCorrected: 'y',
            diffIsDeletion: false,
        })
        const tip = root.querySelector('.gf-tip') as HTMLElement
        // Position must be derived from the supplied rect — the pill sits
        // just below the anchor (space permits) with a 6px gap.
        expect(tip.style.left).toBe('247px')
        expect(tip.style.top).toBe(`${customAnchor.bottom + 6}px`)
    })

    it('renders a .gf-tip__accept button when onAccept is provided (DC: .gf-pillok)', () => {
        // DC reference: the hover pill includes a ✓ quick-accept button
        // (gf-pillok) that applies the suggestion without opening the card.
        const root = mkRoot()
        const onAccept = vi.fn<() => void>()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            diffOriginal: 'was',
            diffCorrected: 'were',
            diffIsDeletion: false,
            onAccept,
        })
        const tip = root.querySelector('.gf-tip') as HTMLElement
        const btn = tip.querySelector('.gf-tip__accept') as HTMLButtonElement
        expect(btn).not.toBeNull()
        expect(btn.textContent?.trim()).toBe('✓')
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onAccept).toHaveBeenCalledOnce()
    })

    it('does NOT render .gf-tip__accept when onAccept is omitted (preview-only mode)', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            diffOriginal: 'was',
            diffCorrected: 'were',
            diffIsDeletion: false,
            // no onAccept
        })
        const tip = root.querySelector('.gf-tip') as HTMLElement
        expect(tip.querySelector('.gf-tip__accept')).toBeNull()
    })

    it('does NOT render .gf-tip__accept for deletion-only corrections (no replacement to accept)', () => {
        const root = mkRoot()
        showTooltip(root, {
            anchorRect: ANCHOR,
            category: 'grammar',
            diffOriginal: 'very',
            diffCorrected: '',
            diffIsDeletion: true,
            onAccept: vi.fn<() => void>(),
        })
        const tip = root.querySelector('.gf-tip') as HTMLElement
        expect(tip.querySelector('.gf-tip__accept')).toBeNull()
    })

    it('positions ABOVE the anchor when space below is insufficient (uses top, not bottom)', () => {
        // Bug-fix: the old code used `style.bottom = vh - anchor.top + gap`
        // on a position:fixed element. CSS `bottom` on fixed = distance from
        // viewport bottom edge, so `vh - anchor.top + 6` is a large value
        // that pushes the pill far off-screen. Fix: use `style.top` instead.
        // jsdom innerHeight = 768. Place the anchor near the bottom so
        // spaceBelow < TOOLTIP_HEIGHT_ESTIMATE (72px).
        const root = mkRoot()
        // anchor.bottom = 750, spaceBelow = 768 - 750 = 18 < 72 → showAbove
        const nearBottomAnchor = new DOMRect(100, 730, 80, 20)
        showTooltip(root, {
            anchorRect: nearBottomAnchor,
            category: 'grammar',
            diffOriginal: 'was',
            diffCorrected: 'were',
            diffIsDeletion: false,
        })
        const tip = root.querySelector('.gf-tip') as HTMLElement
        // Must use top (not bottom) and be above the anchor.
        expect(tip.style.bottom).toBe('auto')
        const topVal = parseInt(tip.style.top, 10)
        expect(Number.isFinite(topVal)).toBe(true)
        // The pill top must be above the anchor top (730).
        expect(topVal).toBeLessThan(nearBottomAnchor.top)
    })
})
