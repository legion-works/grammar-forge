// @vitest-environment jsdom
// Unit tests for the correction card's action wiring + the W1-3 surface
// (source chip, confidence bar, alt chips, nav, keyboard). The glass
// visual is not unit-tested; we verify the rendered structure, the
// dispatched callbacks, and the keyboard shortcuts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showPopover, type PopoverOptions } from '@/overlay/popover'

// jsdom lacks a full Popover API. Stub showPopover/hidePopover as no-ops on the
// prototype so showPopover() takes the top-layer branch without throwing.
// Installed/removed per test.
let popoverStubInstalled = false
function installPopoverStub(): void {
    const proto = HTMLElement.prototype as unknown as {
        showPopover?: () => void
        hidePopover?: () => void
    }
    if (typeof proto.showPopover !== 'function') {
        proto.showPopover = function () {}
        proto.hidePopover = function () {}
        popoverStubInstalled = true
    }
    // Make 'popover' visible on the prototype so isPopoverSupported() returns
    // true and the setAttribute('popover', 'manual') branch is exercised.
    if (!('popover' in proto)) {
        Object.defineProperty(proto, 'popover', {
            value: '',
            writable: true,
            configurable: true,
        })
    }
}
function removePopoverStub(): void {
    if (!popoverStubInstalled) return
    const proto = HTMLElement.prototype as unknown as {
        showPopover?: () => void
        hidePopover?: () => void
    }
    delete proto.showPopover
    delete proto.hidePopover
    popoverStubInstalled = false
}

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

describe('showPopover (W1-3: correction card)', () => {
    let root: ShadowRoot
    beforeEach(() => {
        root = mkRoot()
        installPopoverStub()
    })
    afterEach(() => {
        removePopoverStub()
    })

    it('renders a .gf-card with category label, message, source chip, and primary replacement', () => {
        showPopover(root, mkOptions({ model: 'harper' }))
        const card = root.querySelector('.gf-card')
        expect(card).not.toBeNull()
        expect(card?.getAttribute('role')).toBe('dialog')
        // P2: aria-label includes the category so a screen-reader user
        // hears WHAT kind of issue this is (not just "a grammar correction"
        // for every category).
        expect(card?.getAttribute('aria-label')).toBe('Spelling correction')
        expect(card?.textContent).toContain('Spelling')
        expect(card?.textContent).toContain('Misspelled word')
        expect(card?.textContent).toContain('hello')
        // Source chip shows Harper with the "· instant" hint (W1-3)
        const chip = card?.querySelector('.gf-chip-source')
        expect(chip).not.toBeNull()
        expect(chip?.textContent).toContain('Harper')
        expect(chip?.classList.contains('gf-chip-source--ai')).toBe(false)
    })

    it('aria-label reflects the actual category (not a hardcoded "Grammar correction")', () => {
        showPopover(root, mkOptions({ category: 'grammar' }))
        const card = root.querySelector('.gf-card')
        expect(card?.getAttribute('aria-label')).toBe('Grammar correction')
    })

    it('renders the AI source chip for LLM items', () => {
        showPopover(root, mkOptions({ model: 'llm' }))
        const chip = root.querySelector('.gf-chip-source')
        expect(chip).not.toBeNull()
        expect(chip?.classList.contains('gf-chip-source--ai')).toBe(true)
        expect(chip?.textContent?.trim()).toBe('✨ AI')
    })

    it('renders the confidence bar at the right width and band', () => {
        showPopover(root, mkOptions({ confidence: 0.95 }))
        const fill = root.querySelector<HTMLElement>('.gf-card__confbar-fill')
        expect(fill).not.toBeNull()
        expect(fill?.style.width).toBe('95%')
        expect(fill?.classList.contains('gf-card__confbar-fill--high')).toBe(true)
        // High label
        const color = root.querySelector('.gf-card__conf-color')
        expect(color?.textContent?.trim()).toBe('High')
    })

    it('renders the medium band for 0.75..0.89', () => {
        showPopover(root, mkOptions({ confidence: 0.82 }))
        const fill = root.querySelector('.gf-card__confbar-fill')
        expect(fill?.classList.contains('gf-card__confbar-fill--medium')).toBe(true)
        expect(root.querySelector('.gf-card__conf-color')?.textContent?.trim()).toBe('Medium')
    })

    it('renders the low band for < 0.75', () => {
        showPopover(root, mkOptions({ confidence: 0.5 }))
        const fill = root.querySelector('.gf-card__confbar-fill')
        expect(fill?.classList.contains('gf-card__confbar-fill--low')).toBe(true)
        expect(root.querySelector('.gf-card__conf-color')?.textContent?.trim()).toBe('Low')
    })

    it('renders the alternative replacement chips when replacements.length > 1', () => {
        showPopover(root, mkOptions())
        const alts = root.querySelectorAll<HTMLButtonElement>('.gf-chip-alt')
        expect(alts).toHaveLength(2) // 3 total - 1 primary = 2 extras
        expect(alts[0]?.textContent?.trim()).toBe('helo')
        expect(alts[1]?.textContent?.trim()).toBe('helllo')
    })

    it('omits the alternatives block when only one replacement', () => {
        showPopover(root, mkOptions({ replacements: ['hello'] }))
        expect(root.querySelector('.gf-card__alts')).toBeNull()
    })

    it('renders the nav row with the "N of M" label when navTotal > 0', () => {
        showPopover(root, mkOptions({ navIndex: 2, navTotal: 5 }))
        const nav = root.querySelector('.gf-card__nav')
        expect(nav).not.toBeNull()
        expect(nav?.getAttribute('aria-label')).toBe('Issue navigation')
        expect(nav?.querySelector('.gf-card__nav-count')?.textContent?.trim()).toBe('2 of 5')
        expect(nav?.querySelector('[data-action="nav-prev"]')).not.toBeNull()
        expect(nav?.querySelector('[data-action="nav-next"]')).not.toBeNull()
    })

    it('omits the nav row when navTotal is undefined or 0', () => {
        showPopover(root, mkOptions())
        expect(root.querySelector('.gf-card__nav')).toBeNull()
        showPopover(mkRoot(), mkOptions({ navIndex: 1, navTotal: 0 }))
        expect(root.querySelector('.gf-card__nav')).toBeNull()
    })

    it('positions the card within the viewport (clamped)', () => {
        showPopover(root, mkOptions({ anchorRect: new DOMRect(-9999, -9999, 80, 16) }))
        const card = root.querySelector('.gf-card') as HTMLElement
        // left/top must parse as numbers (jsdom leaves them as "")
        const left = parseFloat(card.style.left)
        const top = parseFloat(card.style.top)
        expect(Number.isFinite(left)).toBe(true)
        expect(Number.isFinite(top)).toBe(true)
    })

    it('Apply button (data-action="apply") calls onApply with index 0', () => {
        const opts = mkOptions()
        showPopover(root, opts)
        const apply = root.querySelector<HTMLButtonElement>('[data-action="apply"]')
        expect(apply).not.toBeNull()
        // W1-3: the primary button is .gf-btn-primary (was .gf-panel__btn--primary)
        expect(apply?.classList.contains('gf-btn-primary')).toBe(true)
        apply?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(opts.onApply).toHaveBeenCalledExactlyOnceWith(0)
    })

    it('clicking an alternative chip calls onApply with the chip index', () => {
        const opts = mkOptions()
        showPopover(root, opts)
        const alts = root.querySelectorAll<HTMLButtonElement>('.gf-chip-alt')
        alts[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        alts[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect(opts.onApply).toHaveBeenCalledTimes(2)
        expect(opts.onApply).toHaveBeenNthCalledWith(1, 1)
        expect(opts.onApply).toHaveBeenNthCalledWith(2, 2)
    })

    it('Dismiss (data-action="dismiss") calls onIgnore and closes the card', () => {
        const opts = mkOptions()
        const handle = showPopover(root, opts)
        const dismiss = root.querySelector<HTMLButtonElement>('[data-action="dismiss"]')
        expect(dismiss).not.toBeNull()
        // The old "ignore" action name is gone — the data-action is "dismiss"
        expect(root.querySelector('[data-action="ignore"]')).toBeNull()
        dismiss?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect(opts.onIgnore).toHaveBeenCalledOnce()
        expect(root.querySelector('.gf-card')).toBeNull()
        expect(handle?.isOpen()).toBe(false)
    })

    it('Add to dictionary is rendered for spelling only', () => {
        showPopover(root, mkOptions({ category: 'spelling' }))
        expect(root.querySelector('[data-action="dictionary"]')).not.toBeNull()
        const r2 = mkRoot()
        showPopover(r2, mkOptions({ category: 'grammar' }))
        expect(r2.querySelector('[data-action="dictionary"]')).toBeNull()
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

    it('nav-prev and nav-next buttons dispatch their callbacks', () => {
        const opts = mkOptions({
            navIndex: 2,
            navTotal: 5,
            onNavPrev: vi.fn<() => void>(),
            onNavNext: vi.fn<() => void>(),
        })
        showPopover(root, opts)
        root.querySelector<HTMLButtonElement>('[data-action="nav-prev"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        )
        root.querySelector<HTMLButtonElement>('[data-action="nav-next"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        )
        expect(opts.onNavPrev).toHaveBeenCalledOnce()
        expect(opts.onNavNext).toHaveBeenCalledOnce()
    })

    it('hide() removes the card and prevents outside-click from firing callbacks', () => {
        const opts = mkOptions()
        const handle = showPopover(root, opts)
        handle?.hide()
        expect(root.querySelector('.gf-card')).toBeNull()
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        expect(opts.onApply).not.toHaveBeenCalled()
        expect(opts.onIgnore).not.toHaveBeenCalled()
    })

    it('uses popover="manual" when the Popover API is available', () => {
        expect(root.querySelector('.gf-card')).toBeNull()
        showPopover(root, mkOptions())
        const card = root.querySelector('.gf-card') as HTMLElement
        const hasPopoverApi = typeof (card as { showPopover?: unknown }).showPopover === 'function'
        const popoverAttr = hasPopoverApi ? card.getAttribute('popover') : null
        expect(popoverAttr).toBe('manual')
    })

    it('preview frame: Apply is disabled, labelled "Checking…", and onApply is not invoked', () => {
        const opts = mkOptions({ preview: true })
        showPopover(root, opts)
        const apply = root.querySelector<HTMLButtonElement>('[data-action="apply"]')
        expect(apply).not.toBeNull()
        expect(apply?.disabled).toBe(true)
        expect(apply?.textContent?.trim()).toContain('Checking')
        apply?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(opts.onApply).not.toHaveBeenCalled()
    })

    it('keyboard: Enter accepts the primary replacement', () => {
        const opts = mkOptions()
        showPopover(root, opts)
        const card = root.querySelector('.gf-card') as HTMLElement
        card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        expect(opts.onApply).toHaveBeenCalledExactlyOnceWith(0)
    })

    it('keyboard: ArrowLeft/Right dispatch onNavPrev/onNavNext', () => {
        const opts = mkOptions({
            onNavPrev: vi.fn<() => void>(),
            onNavNext: vi.fn<() => void>(),
        })
        showPopover(root, opts)
        const card = root.querySelector('.gf-card') as HTMLElement
        card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
        card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        expect(opts.onNavPrev).toHaveBeenCalledOnce()
        expect(opts.onNavNext).toHaveBeenCalledOnce()
    })

    it('keyboard: Escape closes the card via hide()', () => {
        const opts = mkOptions()
        const handle = showPopover(root, opts)
        const card = root.querySelector('.gf-card') as HTMLElement
        card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        expect(handle?.isOpen()).toBe(false)
    })
})

describe('showPopover outside-click dismiss', () => {
    let root: ShadowRoot
    beforeEach(() => {
        root = mkRoot()
        installPopoverStub()
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
        removePopoverStub()
    })

    it('dismisses on a pointerdown outside the card (after the arm delay, window capture)', () => {
        // SYSTEMIC-2 fix: dismiss now uses window capture + pointerdown
        // (not doc + mousedown) so host-page stopPropagation can't block it.
        const opts = mkOptions()
        const handle = showPopover(root, opts)
        // outside-click handler is installed on a setTimeout(0) delay.
        vi.advanceTimersByTime(10)
        // dispatch a pointerdown somewhere far from the card
        const outsideEl = document.createElement('div')
        document.body.appendChild(outsideEl)
        outsideEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
        expect(handle?.isOpen()).toBe(false)
    })

    it('a pointerdown inside the card does not dismiss', () => {
        const opts = mkOptions()
        const handle = showPopover(root, opts)
        vi.advanceTimersByTime(10)
        const card = root.querySelector('.gf-card') as HTMLElement
        card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
        expect(handle?.isOpen()).toBe(true)
    })
})

describe('P1-5: focus restoration on close (every close path)', () => {
    let root: ShadowRoot
    let field: HTMLTextAreaElement
    beforeEach(() => {
        root = mkRoot()
        installPopoverStub()
        vi.useFakeTimers()
        field = document.createElement('textarea')
        document.body.appendChild(field)
        field.focus()
    })
    afterEach(() => {
        vi.useRealTimers()
        removePopoverStub()
        field.remove()
    })

    it('opening the popover moves focus to the primary button (captures the field as "previously focused")', () => {
        expect(document.activeElement).toBe(field)
        showPopover(root, mkOptions())
        // document.activeElement reports the shadow HOST (not the focused
        // descendant) for an open shadow root; the root's own .activeElement
        // is the spec-correct way to see the focused element inside it.
        expect(document.activeElement).not.toBe(field)
        expect(root.activeElement?.classList.contains('gf-btn-primary')).toBe(true)
    })

    it('Escape restores focus to the field', () => {
        showPopover(root, mkOptions())
        const card = root.querySelector('.gf-card') as HTMLElement
        card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        expect(document.activeElement).toBe(field)
    })

    it('outside-click dismiss restores focus to the field', () => {
        showPopover(root, mkOptions())
        vi.advanceTimersByTime(10)
        const outsideEl = document.createElement('div')
        document.body.appendChild(outsideEl)
        outsideEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
        expect(document.activeElement).toBe(field)
    })

    it('the Dismiss button restores focus to the field', () => {
        showPopover(root, mkOptions())
        const dismissBtn = root.querySelector<HTMLElement>('[data-action="dismiss"]')!
        dismissBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(document.activeElement).toBe(field)
    })

    it('a programmatic hide() restores focus to the field', () => {
        const handle = showPopover(root, mkOptions())
        handle.hide()
        expect(document.activeElement).toBe(field)
    })

    it('does not throw and leaves focus alone when the previously-focused element was removed from the DOM', () => {
        const handle = showPopover(root, mkOptions())
        field.remove()
        expect(() => handle.hide()).not.toThrow()
    })
})
