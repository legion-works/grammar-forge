// @vitest-environment jsdom
// Unit tests for the rephrase result card. The glass visual is not
// unit-tested; we only verify that the card renders the rephrased text,
// Apply / Apply-alt / Escape / close / one-per-root behave correctly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    dismissRephraseCardsIn,
    showRephraseCard,
    showRephraseError,
    showRephrasePending,
    type RephraseCardOptions,
} from '@/overlay/rephrase-card'

// jsdom lacks a full Popover API. Stub showPopover/hidePopover as no-ops on
// the prototype so showPopover() takes the top-layer branch without
// throwing. Installed/removed per test (mirror of popover.test.ts).
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

function mkOptions(overrides: Partial<RephraseCardOptions> = {}): RephraseCardOptions {
    return {
        anchorRect: ANCHOR,
        original: 'the cats was here',
        rephrased: 'the cats were here',
        alternatives: ['the cat was here', 'the cats are here'],
        onApply: vi.fn<(text: string) => void>(),
        onClose: vi.fn<() => void>(),
        ...overrides,
    }
}

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}

describe('showRephraseCard', () => {
    let root: ShadowRoot
    beforeEach(() => {
        root = mkRoot()
        installPopoverStub()
    })
    afterEach(() => {
        removePopoverStub()
    })

    it('renders a .gf-rephrase-card with the rephrased text present', () => {
        const opts = mkOptions()
        showRephraseCard(root, opts)
        const card = root.querySelector('.gf-rephrase-card')
        expect(card).not.toBeNull()
        expect(card?.getAttribute('role')).toBe('dialog')
        expect(card?.getAttribute('aria-label')).toBe('Rephrase')
        const text = card?.querySelector('.gf-rephrase-card__text')
        expect(text?.textContent).toBe('the cats were here')
    })

    it('Apply button calls onApply with the rephrased text', () => {
        const opts = mkOptions()
        const handle = showRephraseCard(root, opts)
        const apply = root.querySelector<HTMLButtonElement>('[data-action="apply"]')
        expect(apply).not.toBeNull()
        apply?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(opts.onApply).toHaveBeenCalledExactlyOnceWith('the cats were here')
        expect(handle.isOpen()).toBe(false)
    })

    it('an alternative button calls onApply with that alternative', () => {
        const opts = mkOptions()
        showRephraseCard(root, opts)
        const alts = root.querySelectorAll<HTMLButtonElement>('[data-action="apply-alt"]')
        expect(alts).toHaveLength(2)
        alts[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(opts.onApply).toHaveBeenCalledExactlyOnceWith('the cats are here')
    })

    it('Escape calls onClose and hides the card', () => {
        const opts = mkOptions()
        const handle = showRephraseCard(root, opts)
        const card = root.querySelector('.gf-rephrase-card') as HTMLElement
        card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        expect(opts.onClose).toHaveBeenCalledOnce()
        expect(handle.isOpen()).toBe(false)
    })

    it('close button calls onClose and hides the card', () => {
        const opts = mkOptions()
        const handle = showRephraseCard(root, opts)
        const close = root.querySelector<HTMLButtonElement>('[data-action="close"]')
        expect(close).not.toBeNull()
        close?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(opts.onClose).toHaveBeenCalledOnce()
        expect(handle.isOpen()).toBe(false)
    })

    it('one-per-root: a second showRepraseCard replaces the prior', () => {
        const opts1 = mkOptions({ rephrased: 'first' })
        const opts2 = mkOptions({ rephrased: 'second' })
        showRephraseCard(root, opts1)
        showRephraseCard(root, opts2)
        expect(root.querySelectorAll('.gf-rephrase-card')).toHaveLength(1)
        const text = root.querySelector('.gf-rephrase-card__text')
        expect(text?.textContent).toBe('second')
    })

    it('hide() removes the card', () => {
        const opts = mkOptions()
        const handle = showRephraseCard(root, opts)
        handle.hide()
        expect(root.querySelector('.gf-rephrase-card')).toBeNull()
        expect(handle.isOpen()).toBe(false)
    })

    it('dismissRephraseCardsIn removes every card in the root', () => {
        showRephraseCard(root, mkOptions())
        dismissRephraseCardsIn(root)
        expect(root.querySelector('.gf-rephrase-card')).toBeNull()
    })

    it('uses popover="manual" when the Popover API is available', () => {
        showRephraseCard(root, mkOptions())
        const card = root.querySelector('.gf-rephrase-card') as HTMLElement
        const hasPopoverApi = typeof (card as { showPopover?: unknown }).showPopover === 'function'
        const popoverAttr = hasPopoverApi ? card.getAttribute('popover') : null
        expect(popoverAttr).toBe('manual')
    })
})

describe('pending and error states', () => {
    let root: ShadowRoot
    beforeEach(() => {
        root = mkRoot()
        installPopoverStub()
    })
    afterEach(() => {
        removePopoverStub()
    })

    it('showRephrasePending renders a spinner card with no action buttons', () => {
        const handle = showRephrasePending(root, {
            anchorRect: new DOMRect(),
            onClose: () => {},
        })
        const card = root.querySelector('.gf-rephrase-card--pending')
        expect(card).not.toBeNull()
        expect(card!.querySelector('[data-action="apply"]')).toBeNull()
        expect(card!.textContent).toContain('Rephrasing')
        expect(handle.isOpen()).toBe(true)
    })

    it('a result card replaces a pending card (one-per-root)', () => {
        showRephrasePending(root, { anchorRect: new DOMRect(), onClose: () => {} })
        showRephraseCard(root, mkOptions({}))
        expect(root.querySelectorAll('.gf-rephrase-card')).toHaveLength(1)
        expect(root.querySelector('.gf-rephrase-card--pending')).toBeNull()
    })

    it('showRephraseError renders the message and Retry fires onRetry', () => {
        const onRetry = vi.fn<() => void>()
        showRephraseError(root, {
            anchorRect: new DOMRect(),
            message: 'Rephrase failed',
            onRetry,
            onClose: () => {},
        })
        const card = root.querySelector('.gf-rephrase-card--error')!
        expect(card.textContent).toContain('Rephrase failed')
        const retry = card.querySelector<HTMLElement>('[data-action="retry"]')!
        retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect(onRetry).toHaveBeenCalledTimes(1)
        // retry closes the card (the caller is expected to re-show pending or
        // a result via the rephrase flow).
        expect(root.querySelector('.gf-rephrase-card--error')).toBeNull()
    })
})
