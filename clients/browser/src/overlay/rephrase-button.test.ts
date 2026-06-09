// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { dismissRephraseButtonsIn, showRephraseButton } from '@/overlay/rephrase-button'

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}

const ANCHOR = new DOMRect(100, 100, 80, 16)

describe('showRephraseButton', () => {
    it('mounts a .gf-rephrase-btn button in the root', () => {
        const root = mkRoot()
        showRephraseButton(root, { anchorRect: ANCHOR, onClick: vi.fn<() => void>() })
        const btn = root.querySelector('.gf-rephrase-btn')
        expect(btn).not.toBeNull()
        expect(btn?.tagName).toBe('BUTTON')
        expect(btn?.getAttribute('type')).toBe('button')
        expect(btn?.textContent).toBe('Rephrase')
    })

    it('clicking the button fires onClick once and preventDefaults the click', () => {
        const root = mkRoot()
        const onClick = vi.fn<() => void>()
        showRephraseButton(root, { anchorRect: ANCHOR, onClick })
        const btn = root.querySelector('.gf-rephrase-btn') as HTMLElement
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
        const prevented = !btn.dispatchEvent(ev)
        expect(onClick).toHaveBeenCalledOnce()
        expect(prevented).toBe(true)
    })

    it('mousedown on the button is preventDefaulted (keeps the field focused)', () => {
        const root = mkRoot()
        showRephraseButton(root, { anchorRect: ANCHOR, onClick: vi.fn<() => void>() })
        const btn = root.querySelector('.gf-rephrase-btn') as HTMLElement
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
        const prevented = !btn.dispatchEvent(ev)
        expect(prevented).toBe(true)
    })

    it('hide() removes the button and isOpen() reflects state', () => {
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
        const btn = root.querySelector('.gf-rephrase-btn') as HTMLElement
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onClick1).not.toHaveBeenCalled()
        expect(onClick2).toHaveBeenCalledOnce()
    })

    it('dismissRephraseButtonsIn removes every Rephrase button in the root', () => {
        const root = mkRoot()
        showRephraseButton(root, { anchorRect: ANCHOR, onClick: vi.fn<() => void>() })
        dismissRephraseButtonsIn(root)
        expect(root.querySelector('.gf-rephrase-btn')).toBeNull()
    })
})
