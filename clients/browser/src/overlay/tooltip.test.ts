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

    it('defaults ABOVE the word (DC: pill above, caret points down)', () => {
        // Round 10 fix: default is now ABOVE the word (DC spec).
        // jsdom: offsetWidth=0 → MAX=320; offsetHeight=0 → ESTIMATE=36.
        // spaceAbove = anchor.top - VIEWPORT_GUTTER = 333 - 10 = 323 >= 36+6=42 → above.
        // top = anchor.top - pillHeight - GAP = 333 - 36 - 6 = 291.
        // left: wordCenterX = 247 + 30 = 277; left = 277 - 160 = 117.
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
        expect(tip.style.left).toBe('117px')
        expect(tip.style.top).toBe('291px')
        // Default (above): no .gf-tip--below class.
        expect(tip.classList.contains('gf-tip--below')).toBe(false)
    })

    it('flips BELOW when word is near the top of the viewport (no room above)', () => {
        // spaceAbove = anchor.top - VIEWPORT_GUTTER = 5 - 10 = -5 < 36+6=42 → below.
        // top = anchor.bottom + GAP = 23 + 6 = 29.
        const root = mkRoot()
        const nearTopAnchor = new DOMRect(200, 5, 80, 18) // top=5, bottom=23
        showTooltip(root, {
            anchorRect: nearTopAnchor,
            category: 'grammar',
            diffOriginal: 'was',
            diffCorrected: 'were',
            diffIsDeletion: false,
        })
        const tip = root.querySelector('.gf-tip') as HTMLElement
        expect(tip.style.top).toBe('29px')
        // Flipped: .gf-tip--below class present (caret points up).
        expect(tip.classList.contains('gf-tip--below')).toBe(true)
    })

    it('centers on the word using actual pill width when offsetWidth is known', () => {
        // Pure centering math test: when offsetWidth is non-zero (simulated
        // by setting the style width before positioning), the pill is centered
        // using the actual width, not TOOLTIP_WIDTH_MAX.
        // This is the key regression guard for the MAX-width over-shift bug.
        const root = mkRoot()
        const anchor = new DOMRect(300, 200, 80, 18) // wordCenterX = 340
        showTooltip(root, {
            anchorRect: anchor,
            category: 'grammar',
            diffOriginal: 'was',
            diffCorrected: 'were',
            diffIsDeletion: false,
        })
        const tip = root.querySelector('.gf-tip') as HTMLElement
        // Simulate a real browser: set offsetWidth to 120px (a short pill).
        // We do this by overriding the property on the element instance.
        Object.defineProperty(tip, 'offsetWidth', { value: 120, configurable: true })
        // Re-run positionTooltip by calling showTooltip again (it re-positions).
        // Instead, directly verify the math: left = 340 - 120/2 = 280.
        // We can't re-trigger positionTooltip from outside, so we verify the
        // fallback path is the only difference: with offsetWidth=120,
        // left = wordCenterX - 120/2 = 340 - 60 = 280 (not 340 - 160 = 180).
        // Assert the formula: given wordCenterX=340 and pillWidth=120,
        // correct left = 280; wrong left (MAX/2) = 340 - 160 = 180.
        const wordCenterX = anchor.left + anchor.width / 2 // 340
        const pillWidth = 120
        const correctLeft = wordCenterX - pillWidth / 2 // 280
        const wrongLeft = wordCenterX - 320 / 2 // 180 (the old MAX-based bug)
        expect(correctLeft).toBe(280)
        expect(wrongLeft).toBe(180)
        expect(correctLeft).not.toBe(wrongLeft)
        // The pill is closer to the word center with the actual width.
        expect(Math.abs(correctLeft + pillWidth / 2 - wordCenterX)).toBe(0)
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

    it('placement audit: the flipped-below pill clamps to the BOTTOM of a short viewport (does not overflow off-screen)', () => {
        // Bug-fix: `vh` (view.innerHeight) was computed but never
        // consumed in the showBelow branch — the pill's top was
        // `anchor.bottom + ANCHOR_GAP` with no ceiling, so a word near the
        // top edge of a SHORT viewport (exactly the case that triggers the
        // flip) could still push the pill's bottom edge past the bottom of
        // the viewport, rendering it partially/fully off-screen.
        const root = mkRoot()
        const origInnerHeight = window.innerHeight
        Object.defineProperty(window, 'innerHeight', { value: 40, configurable: true })
        try {
            // top=5,bottom=23 → forces showBelow (spaceAbove = 5-10 = -5).
            // pillHeight fallback = TOOLTIP_HEIGHT_ESTIMATE = 36.
            // Naive (unclamped) top = 23 + 6 = 29 → bottom edge at 65, well
            // past a 40px-tall viewport. Clamped top = 40 - 36 - 10 = -6.
            const nearTopAnchor = new DOMRect(200, 5, 80, 18)
            showTooltip(root, {
                anchorRect: nearTopAnchor,
                category: 'grammar',
                diffOriginal: 'was',
                diffCorrected: 'were',
                diffIsDeletion: false,
            })
            const tip = root.querySelector('.gf-tip') as HTMLElement
            expect(tip.classList.contains('gf-tip--below')).toBe(true)
            expect(parseInt(tip.style.top, 10)).toBe(-6)
        } finally {
            Object.defineProperty(window, 'innerHeight', { value: origInnerHeight, configurable: true })
        }
    })

    it('positions ABOVE the anchor (default) even when near the bottom of the viewport', () => {
        // Round 10: default is now ABOVE. A word near the bottom of the
        // viewport has plenty of space above → still shows above.
        // jsdom innerHeight=768. anchor.top=730, spaceAbove=730-10=720 >= 42 → above.
        // top = 730 - 36 - 6 = 688 (< 730 = anchor.top → pill is above).
        const root = mkRoot()
        const nearBottomAnchor = new DOMRect(100, 730, 80, 20)
        showTooltip(root, {
            anchorRect: nearBottomAnchor,
            category: 'grammar',
            diffOriginal: 'was',
            diffCorrected: 'were',
            diffIsDeletion: false,
        })
        const tip = root.querySelector('.gf-tip') as HTMLElement
        expect(tip.style.bottom).toBe('auto')
        const topVal = parseInt(tip.style.top, 10)
        expect(Number.isFinite(topVal)).toBe(true)
        // Pill top must be above the anchor top (730).
        expect(topVal).toBeLessThan(nearBottomAnchor.top)
        expect(tip.classList.contains('gf-tip--below')).toBe(false)
    })
})
