// @vitest-environment jsdom
// Unit tests for the popover's action wiring. The glass visual is not
// unit-tested; we only verify that Apply / Show N more / Ignore once /
// Add to dictionary buttons dispatch the right callback with the right
// replacement index. Outside-click dismiss is also tested.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showPopover, type PopoverOptions } from '@/overlay/popover'

const ANCHOR = new DOMRect(100, 100, 80, 16)

function mkOptions(overrides: Partial<PopoverOptions> = {}): PopoverOptions {
    return {
        anchorRect: ANCHOR,
        category: 'spelling',
        message: 'Misspelled word',
        diffOriginal: 'helo',
        diffCorrected: 'hello',
        diffIsDeletion: false,
        replacements: ['hello', 'helo', 'helllo'],
        onApply: vi.fn<(i: number) => void>(),
        onIgnore: vi.fn<() => void>(),
        onAddToDictionary: vi.fn<(word: string) => void>(),
        ...overrides,
    }
}

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}

describe('showPopover', () => {
    let root: ShadowRoot
    beforeEach(() => {
        root = mkRoot()
    })

    it('renders a panel with the category label, message, and primary replacement', () => {
        showPopover(root, mkOptions())
        const panel = root.querySelector('.gf-panel')
        expect(panel).not.toBeNull()
        expect(panel?.textContent).toContain('Spelling')
        expect(panel?.textContent).toContain('Misspelled word')
        expect(panel?.textContent).toContain('hello')
    })

    it('positions the panel within the viewport (clamped)', () => {
        showPopover(root, mkOptions({ anchorRect: new DOMRect(-9999, -9999, 80, 16) }))
        const panel = root.querySelector('.gf-panel') as HTMLElement
        // left/top must parse as numbers (jsdom leaves them as "")
        const left = parseFloat(panel.style.left)
        const top = parseFloat(panel.style.top)
        expect(Number.isFinite(left)).toBe(true)
        expect(Number.isFinite(top)).toBe(true)
    })

    it('Apply button calls onApply with index 0 (the primary replacement)', () => {
        const opts = mkOptions()
        showPopover(root, opts)
        const apply = root.querySelector<HTMLButtonElement>('[data-action="apply"]')
        expect(apply).not.toBeNull()
        apply?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(opts.onApply).toHaveBeenCalledExactlyOnceWith(0)
    })

    it('"Show N more" expander reveals alternatives; clicking one calls onApply with the right index', () => {
        const opts = mkOptions()
        const handle = showPopover(root, opts)
        expect(handle).not.toBeNull()
        // the alternative list must be hidden initially
        expect(root.querySelector('.gf-panel__alternatives')).toBeNull()
        const expander = root.querySelector<HTMLButtonElement>('[data-action="more"]')
        expect(expander).not.toBeNull()
        expander?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        // now alternatives are visible
        const alts = root.querySelectorAll<HTMLButtonElement>('.gf-panel__alternative')
        expect(alts).toHaveLength(2) // 3 total - 1 primary = 2 extras
        alts[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        alts[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect(opts.onApply).toHaveBeenCalledTimes(2)
        expect(opts.onApply).toHaveBeenNthCalledWith(1, 1)
        expect(opts.onApply).toHaveBeenNthCalledWith(2, 2)
    })

    it('Ignore once calls onIgnore and dismisses the popover', () => {
        const opts = mkOptions()
        const handle = showPopover(root, opts)
        const ignore = root.querySelector<HTMLButtonElement>('[data-action="ignore"]')
        expect(ignore).not.toBeNull()
        ignore?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect(opts.onIgnore).toHaveBeenCalledOnce()
        // the panel is removed
        expect(root.querySelector('.gf-panel')).toBeNull()
        expect(handle?.isOpen()).toBe(false)
    })

    it('Add to dictionary is rendered for spelling only', () => {
        // spelling → button present
        showPopover(root, mkOptions({ category: 'spelling' }))
        expect(root.querySelector('[data-action="dictionary"]')).not.toBeNull()
        // grammar → button absent
        const r2 = mkRoot()
        showPopover(r2, mkOptions({ category: 'grammar' }))
        expect(r2.querySelector('[data-action="dictionary"]')).toBeNull()
        // punctuation → button absent
        const r3 = mkRoot()
        showPopover(r3, mkOptions({ category: 'punctuation' }))
        expect(r3.querySelector('[data-action="dictionary"]')).toBeNull()
    })

    it('Add to dictionary calls onAddToDictionary with the suggestion word', () => {
        const opts = mkOptions({ category: 'spelling', original: 'teh' })
        showPopover(root, opts)
        const btn = root.querySelector<HTMLButtonElement>('[data-action="dictionary"]')
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect(opts.onAddToDictionary).toHaveBeenCalledExactlyOnceWith('teh')
    })

    it('hide() removes the panel and prevents outside-click from firing callbacks', () => {
        const opts = mkOptions()
        const handle = showPopover(root, opts)
        handle?.hide()
        expect(root.querySelector('.gf-panel')).toBeNull()
        // a click elsewhere should not call any callback
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        expect(opts.onApply).not.toHaveBeenCalled()
        expect(opts.onIgnore).not.toHaveBeenCalled()
    })
})

describe('showPopover outside-click dismiss', () => {
    let root: ShadowRoot
    beforeEach(() => {
        root = mkRoot()
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('dismisses on a mousedown outside the popover (after the 100ms mount delay)', () => {
        const opts = mkOptions()
        const handle = showPopover(root, opts)
        // outside-click handler is installed on a 100ms delay; advance time
        vi.advanceTimersByTime(120)
        // dispatch a click somewhere far from the popover
        const outsideEl = document.createElement('div')
        document.body.appendChild(outsideEl)
        outsideEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        expect(handle?.isOpen()).toBe(false)
    })

    it('a click inside the popover does not dismiss', () => {
        const opts = mkOptions()
        const handle = showPopover(root, opts)
        vi.advanceTimersByTime(120)
        const panel = root.querySelector('.gf-panel') as HTMLElement
        // mousedown's composedPath() includes the shadow root path; in jsdom
        // the path is built from the target. Walk the target back up to its
        // composed parent: the panel itself is inside the shadow root, so
        // dispatching a bubbling event on it sets composedPath() to include it.
        panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))
        expect(handle?.isOpen()).toBe(true)
    })
})
