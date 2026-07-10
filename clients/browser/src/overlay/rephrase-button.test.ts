// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { dismissRephraseButtonsIn, showRephraseButton } from '@/overlay/rephrase-button'

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}

const ANCHOR = new DOMRect(100, 100, 80, 16)

describe('showRephraseButton (split control: Rephrase + Synonyms)', () => {
    it('mounts a .gf-rephrase-btn container as a role="group" with an aria-label', () => {
        const root = mkRoot()
        showRephraseButton(root, { anchorRect: ANCHOR, onClick: vi.fn<() => void>() })
        const container = root.querySelector('.gf-rephrase-btn')
        expect(container).not.toBeNull()
        expect(container?.getAttribute('role')).toBe('group')
        expect(container?.getAttribute('aria-label')).toBeTruthy()
    })

    it('renders TWO real <button> segments: primary (Rephrase) and secondary (Synonyms)', () => {
        const root = mkRoot()
        showRephraseButton(root, { anchorRect: ANCHOR, onClick: vi.fn<() => void>() })
        const primary = root.querySelector('.gf-rephrase-btn__primary')
        const synonyms = root.querySelector('.gf-rephrase-btn__synonyms')
        expect(primary?.tagName).toBe('BUTTON')
        expect(primary?.getAttribute('type')).toBe('button')
        expect(primary?.textContent).toContain('Rephrase')
        expect(synonyms?.tagName).toBe('BUTTON')
        expect(synonyms?.getAttribute('type')).toBe('button')
        expect(synonyms?.textContent).toBe('Synonyms')
    })

    it('renders a hairline divider between the two segments', () => {
        const root = mkRoot()
        showRephraseButton(root, { anchorRect: ANCHOR, onClick: vi.fn<() => void>() })
        expect(root.querySelector('.gf-rephrase-btn__divider')).not.toBeNull()
    })

    it('clicking the primary segment fires onClick once and preventDefaults the click', () => {
        const root = mkRoot()
        const onClick = vi.fn<() => void>()
        showRephraseButton(root, { anchorRect: ANCHOR, onClick })
        const btn = root.querySelector('.gf-rephrase-btn__primary') as HTMLElement
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
        const prevented = !btn.dispatchEvent(ev)
        expect(onClick).toHaveBeenCalledOnce()
        expect(prevented).toBe(true)
    })

    it('mousedown on the primary segment is preventDefaulted (keeps the field focused)', () => {
        const root = mkRoot()
        showRephraseButton(root, { anchorRect: ANCHOR, onClick: vi.fn<() => void>() })
        const btn = root.querySelector('.gf-rephrase-btn__primary') as HTMLElement
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
        const prevented = !btn.dispatchEvent(ev)
        expect(prevented).toBe(true)
    })

    it('hide() removes the whole control and isOpen() reflects state', () => {
        const root = mkRoot()
        const h = showRephraseButton(root, { anchorRect: ANCHOR, onClick: vi.fn<() => void>() })
        expect(h.isOpen()).toBe(true)
        h.hide()
        expect(h.isOpen()).toBe(false)
        expect(root.querySelector('.gf-rephrase-btn')).toBeNull()
    })

    it('one-per-root: a second showRephraseButton replaces the prior', () => {
        const root = mkRoot()
        const onClick1 = vi.fn<() => void>()
        const onClick2 = vi.fn<() => void>()
        showRephraseButton(root, { anchorRect: ANCHOR, onClick: onClick1 })
        showRephraseButton(root, { anchorRect: ANCHOR, onClick: onClick2 })
        expect(root.querySelectorAll('.gf-rephrase-btn')).toHaveLength(1)
        // only the second onClick is wired
        const btn = root.querySelector('.gf-rephrase-btn__primary') as HTMLElement
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onClick1).not.toHaveBeenCalled()
        expect(onClick2).toHaveBeenCalledOnce()
    })

    it('dismissRephraseButtonsIn removes every split control in the root', () => {
        const root = mkRoot()
        showRephraseButton(root, { anchorRect: ANCHOR, onClick: vi.fn<() => void>() })
        dismissRephraseButtonsIn(root)
        expect(root.querySelector('.gf-rephrase-btn')).toBeNull()
    })

    describe('clearRect (placement audit — Discord composer/toolbar clearance)', () => {
        // jsdom defaults: innerWidth=1024, innerHeight=768.
        // REPHRASE_BUTTON_HEIGHT_FALLBACK=32, ANCHOR_GAP=6 (module-private).

        it('when flipped ABOVE, clears the TOP of clearRect (not just the selection) when clearRect starts higher', () => {
            // anchor near the bottom → forces the above-flip
            // (spaceBelow = 768-760=8 < 32+6=38).
            const anchor = new DOMRect(100, 740, 80, 20) // bottom=760
            const root = mkRoot()
            showRephraseButton(root, {
                anchorRect: anchor,
                onClick: vi.fn<() => void>(),
                clearRect: new DOMRect(50, 700, 400, 200), // top=700, higher than anchor.top=740
            })
            const container = root.querySelector('.gf-rephrase-btn') as HTMLElement
            // Without clearRect: bottom = 768 - 740 + 6 = 34.
            // With clearRect (top=700 < anchor.top=740): bottom = 768 - 700 + 6 = 74.
            expect(container.style.bottom).toBe('74px')
        })

        it('when flipped ABOVE and clearRect is a NO-OP (fully inside the anchor), positions the same as without it', () => {
            const anchor = new DOMRect(100, 740, 80, 20)
            const root = mkRoot()
            showRephraseButton(root, {
                anchorRect: anchor,
                onClick: vi.fn<() => void>(),
                // clearRect.top BELOW anchor.top → aboveEdge stays anchor.top.
                clearRect: new DOMRect(50, 750, 400, 5),
            })
            const container = root.querySelector('.gf-rephrase-btn') as HTMLElement
            expect(container.style.bottom).toBe('34px')
        })

        it('when placed BELOW, clears the BOTTOM of clearRect when it extends past the selection', () => {
            // Plenty of room below → no flip (spaceBelow = 768-100=668 >= 38).
            const anchor = new DOMRect(100, 80, 80, 20) // bottom=100
            const root = mkRoot()
            showRephraseButton(root, {
                anchorRect: anchor,
                onClick: vi.fn<() => void>(),
                clearRect: new DOMRect(50, 60, 400, 240), // bottom=300, past anchor.bottom=100
            })
            const container = root.querySelector('.gf-rephrase-btn') as HTMLElement
            // Without clearRect: top = 100 + 6 = 106.
            // With clearRect (bottom=300 > anchor.bottom=100): top = 300 + 6 = 306.
            expect(container.style.top).toBe('306px')
        })

        it('omitting clearRect positions exactly as before (back-compat — browser client passes none)', () => {
            const anchor = new DOMRect(100, 80, 80, 20)
            const root = mkRoot()
            showRephraseButton(root, { anchorRect: anchor, onClick: vi.fn<() => void>() })
            const container = root.querySelector('.gf-rephrase-btn') as HTMLElement
            expect(container.style.top).toBe('106px')
        })
    })

    describe('Synonyms segment enablement', () => {
        it('defaults to disabled (aria-disabled + native disabled) when synonymsEnabled is omitted', () => {
            const root = mkRoot()
            showRephraseButton(root, { anchorRect: ANCHOR, onClick: vi.fn<() => void>() })
            const synonyms = root.querySelector('.gf-rephrase-btn__synonyms') as HTMLButtonElement
            expect(synonyms.disabled).toBe(true)
            expect(synonyms.getAttribute('aria-disabled')).toBe('true')
        })

        it('sets a title explaining why Synonyms is disabled when synonymsDisabledReason is supplied', () => {
            const root = mkRoot()
            showRephraseButton(root, {
                anchorRect: ANCHOR,
                onClick: vi.fn<() => void>(),
                synonymsEnabled: false,
                synonymsDisabledReason: 'Select a single word to see synonyms',
            })
            const synonyms = root.querySelector('.gf-rephrase-btn__synonyms') as HTMLButtonElement
            expect(synonyms.title).toBe('Select a single word to see synonyms')
        })

        it('enables the Synonyms segment and wires onSynonymsClick when synonymsEnabled is true', () => {
            const root = mkRoot()
            const onSynonymsClick = vi.fn<() => void>()
            showRephraseButton(root, {
                anchorRect: ANCHOR,
                onClick: vi.fn<() => void>(),
                synonymsEnabled: true,
                onSynonymsClick,
            })
            const synonyms = root.querySelector('.gf-rephrase-btn__synonyms') as HTMLButtonElement
            expect(synonyms.disabled).toBe(false)
            expect(synonyms.hasAttribute('aria-disabled')).toBe(false)
            const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
            const prevented = !synonyms.dispatchEvent(ev)
            expect(onSynonymsClick).toHaveBeenCalledOnce()
            expect(prevented).toBe(true)
        })

        it('a disabled Synonyms segment does not fire onSynonymsClick on click (native disabled semantics)', () => {
            const root = mkRoot()
            const onSynonymsClick = vi.fn<() => void>()
            showRephraseButton(root, {
                anchorRect: ANCHOR,
                onClick: vi.fn<() => void>(),
                synonymsEnabled: false,
                onSynonymsClick,
            })
            const synonyms = root.querySelector('.gf-rephrase-btn__synonyms') as HTMLButtonElement
            synonyms.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
            expect(onSynonymsClick).not.toHaveBeenCalled()
        })

        it('mousedown on the enabled Synonyms segment is preventDefaulted (keeps the field focused)', () => {
            const root = mkRoot()
            showRephraseButton(root, {
                anchorRect: ANCHOR,
                onClick: vi.fn<() => void>(),
                synonymsEnabled: true,
                onSynonymsClick: vi.fn<() => void>(),
            })
            const synonyms = root.querySelector('.gf-rephrase-btn__synonyms') as HTMLElement
            const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
            const prevented = !synonyms.dispatchEvent(ev)
            expect(prevented).toBe(true)
        })
    })
})
