// @vitest-environment jsdom
// Unit tests for the rephrase result card. The glass visual is not
// unit-tested; we only verify that the card renders the rephrased text,
// Accept / accept-alt / scope / tone / regenerate / Escape / close /
// one-per-root behave correctly.
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
        scope: 'sentence',
        tone: 'neutral',
        onAccept: vi.fn<(text: string) => void>(),
        onClose: vi.fn<() => void>(),
        onScopeChange: vi.fn<(scope: 'sentence' | 'message') => void>(),
        onToneChange: vi.fn<(tone: 'neutral' | 'formal' | 'casual') => void>(),
        onRegenerate: vi.fn<() => void>(),
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

    it('renders a .gf-rephrase card with the rephrased text present', () => {
        const opts = mkOptions()
        showRephraseCard(root, opts)
        const card = root.querySelector('.gf-rephrase')
        expect(card).not.toBeNull()
        expect(card?.getAttribute('role')).toBe('dialog')
        expect(card?.getAttribute('aria-label')).toBe('Rephrase')
        const text = card?.querySelector('.gf-rephrase__text')
        expect(text?.textContent).toBe('the cats were here')
    })

    it('Accept button calls onAccept with the rephrased text', () => {
        const opts = mkOptions()
        const handle = showRephraseCard(root, opts)
        const accept = root.querySelector<HTMLButtonElement>('[data-action="accept"]')
        expect(accept).not.toBeNull()
        accept?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(opts.onAccept).toHaveBeenCalledExactlyOnceWith('the cats were here')
        expect(handle.isOpen()).toBe(false)
    })

    it('an alternative chip calls onAccept with that alternative', () => {
        const opts = mkOptions()
        showRephraseCard(root, opts)
        const alts = root.querySelectorAll<HTMLButtonElement>('[data-action="accept-alt"]')
        expect(alts).toHaveLength(2)
        alts[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(opts.onAccept).toHaveBeenCalledExactlyOnceWith('the cats are here')
    })

    it('Escape calls onClose and hides the card', () => {
        const opts = mkOptions()
        const handle = showRephraseCard(root, opts)
        const card = root.querySelector('.gf-rephrase') as HTMLElement
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

    it('one-per-root: a second showRephraseCard replaces the prior', () => {
        const opts1 = mkOptions({ rephrased: 'first' })
        const opts2 = mkOptions({ rephrased: 'second' })
        showRephraseCard(root, opts1)
        showRephraseCard(root, opts2)
        expect(root.querySelectorAll('.gf-rephrase')).toHaveLength(1)
        const text = root.querySelector('.gf-rephrase__text')
        expect(text?.textContent).toBe('second')
    })

    it('hide() removes the card', () => {
        const opts = mkOptions()
        const handle = showRephraseCard(root, opts)
        handle.hide()
        expect(root.querySelector('.gf-rephrase')).toBeNull()
        expect(handle.isOpen()).toBe(false)
    })

    it('dismissRephraseCardsIn removes every card in the root', () => {
        showRephraseCard(root, mkOptions())
        dismissRephraseCardsIn(root)
        expect(root.querySelector('.gf-rephrase')).toBeNull()
    })

    it('uses popover="manual" when the Popover API is available', () => {
        showRephraseCard(root, mkOptions())
        const card = root.querySelector('.gf-rephrase') as HTMLElement
        const hasPopoverApi = typeof (card as { showPopover?: unknown }).showPopover === 'function'
        const popoverAttr = hasPopoverApi ? card.getAttribute('popover') : null
        expect(popoverAttr).toBe('manual')
    })
})

describe('rephrase card scope + tone controls', () => {
    let root: ShadowRoot
    beforeEach(() => {
        root = mkRoot()
        installPopoverStub()
    })
    afterEach(() => {
        removePopoverStub()
    })

    it('renders the two scope seg buttons with the active one carrying .is-active', () => {
        showRephraseCard(root, mkOptions({ scope: 'message' }))
        const scopeBtns = root.querySelectorAll<HTMLButtonElement>('[data-action="scope"]')
        expect(scopeBtns).toHaveLength(2)
        const values = Array.from(scopeBtns).map((b) => b.dataset.value)
        expect(values).toEqual(['sentence', 'message'])
        const active = Array.from(scopeBtns).find((b) => b.classList.contains('is-active'))
        expect(active?.dataset.value).toBe('message')
    })

    it('clicking a scope seg button fires onScopeChange with that scope and keeps the card open', () => {
        const opts = mkOptions({ scope: 'sentence' })
        const handle = showRephraseCard(root, opts)
        const msgBtn = root.querySelector<HTMLButtonElement>(
            '[data-action="scope"][data-value="message"]',
        )
        expect(msgBtn).not.toBeNull()
        msgBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(opts.onScopeChange).toHaveBeenCalledExactlyOnceWith('message')
        // The card stays open — the orchestrator replaces it with a pending then result.
        expect(handle.isOpen()).toBe(true)
    })

    it('renders the three tone seg buttons with the active one carrying .is-active', () => {
        showRephraseCard(root, mkOptions({ tone: 'formal' }))
        const toneBtns = root.querySelectorAll<HTMLButtonElement>('[data-action="tone"]')
        expect(toneBtns).toHaveLength(3)
        const values = Array.from(toneBtns).map((b) => b.dataset.value)
        expect(values).toEqual(['neutral', 'formal', 'casual'])
        const active = Array.from(toneBtns).find((b) => b.classList.contains('is-active'))
        expect(active?.dataset.value).toBe('formal')
    })

    it('clicking a tone seg button fires onToneChange with that tone', () => {
        const opts = mkOptions({ tone: 'neutral' })
        const handle = showRephraseCard(root, opts)
        const casualBtn = root.querySelector<HTMLButtonElement>(
            '[data-action="tone"][data-value="casual"]',
        )
        casualBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(opts.onToneChange).toHaveBeenCalledExactlyOnceWith('casual')
        expect(handle.isOpen()).toBe(true)
    })

    it('clicking the Regenerate button fires onRegenerate', () => {
        const opts = mkOptions()
        const handle = showRephraseCard(root, opts)
        const regen = root.querySelector<HTMLButtonElement>('[data-action="regenerate"]')
        expect(regen).not.toBeNull()
        regen?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(opts.onRegenerate).toHaveBeenCalledTimes(1)
        // The card stays open — the orchestrator swaps in a pending card then
        // a new result. The card itself is a render target, not a state owner.
        expect(handle.isOpen()).toBe(true)
    })
})

describe('rephrase card head', () => {
    let root: ShadowRoot
    beforeEach(() => {
        root = mkRoot()
        installPopoverStub()
    })
    afterEach(() => {
        removePopoverStub()
    })

    it('shows the modelLabel as .gf-rephrase__head-model text in the head when provided', () => {
        showRephraseCard(root, mkOptions({ modelLabel: 'Gemma' }))
        const head = root.querySelector('.gf-rephrase__head')
        expect(head).not.toBeNull()
        const model = head?.querySelector('.gf-rephrase__head-model')
        expect(model?.textContent).toContain('Gemma')
    })

    it('omits the model span when modelLabel is not provided', () => {
        showRephraseCard(root, mkOptions())
        const head = root.querySelector('.gf-rephrase__head')
        expect(head?.querySelector('.gf-rephrase__head-model')).toBeNull()
    })
})

describe('rephrase card outside-click dismiss (round 11 regression guard)', () => {
    // ROOT CAUSE: mountSimpleCard had no installOutsideDismiss call.
    // The card had no outside-click listener at all — clicking outside
    // never closed it. Fix: installOutsideDismiss (window capture, one-shot).
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

    it('outside pointerdown closes the card (node removed + onClose called)', async () => {
        const opts = mkOptions()
        const handle = showRephraseCard(root, opts)
        expect(handle.isOpen()).toBe(true)
        // Arm the outside-dismiss listener (setTimeout 0).
        vi.advanceTimersByTime(10)
        // Dispatch a pointerdown outside the card.
        document.body.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }),
        )
        expect(handle.isOpen()).toBe(false)
        expect(root.querySelector('.gf-rephrase')).toBeNull()
        expect(opts.onClose).toHaveBeenCalledOnce()
    })

    it('outside pointerdown fires onClose exactly ONCE (one-shot, no repeats)', async () => {
        const opts = mkOptions()
        showRephraseCard(root, opts)
        vi.advanceTimersByTime(10)
        // Fire three outside clicks.
        for (let i = 0; i < 3; i++) {
            document.body.dispatchEvent(
                new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }),
            )
        }
        expect(opts.onClose).toHaveBeenCalledTimes(1)
    })

    it('pointerdown INSIDE the card (e.g. tone toggle) does NOT dismiss', async () => {
        const opts = mkOptions()
        const handle = showRephraseCard(root, opts)
        vi.advanceTimersByTime(10)
        // Click a tone button inside the card.
        const toneBtn = root.querySelector<HTMLButtonElement>('[data-action="tone"]')
        expect(toneBtn).not.toBeNull()
        toneBtn?.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }),
        )
        expect(handle.isOpen()).toBe(true)
        expect(opts.onClose).not.toHaveBeenCalled()
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

    it('showRephrasePending renders a skeleton + "Generating" label', () => {
        const handle = showRephrasePending(root, {
            anchorRect: new DOMRect(),
            onClose: () => {},
            modelLabel: 'Gemma',
        })
        const card = root.querySelector('.gf-rephrase--pending')
        expect(card).not.toBeNull()
        expect(card!.querySelector('[data-action="accept"]')).toBeNull()
        expect(card!.querySelectorAll('.gf-skel').length).toBeGreaterThanOrEqual(2)
        expect(card!.textContent).toContain('Generating')
        expect(card!.textContent).toContain('Gemma')
        expect(handle.isOpen()).toBe(true)
    })

    it('a result card replaces a pending card (one-per-root)', () => {
        showRephrasePending(root, { anchorRect: new DOMRect(), onClose: () => {} })
        showRephraseCard(root, mkOptions({}))
        expect(root.querySelectorAll('.gf-rephrase')).toHaveLength(1)
        expect(root.querySelector('.gf-rephrase--pending')).toBeNull()
    })

    it('showRephraseError renders the message and Retry fires onRetry', () => {
        const onRetry = vi.fn<() => void>()
        showRephraseError(root, {
            anchorRect: new DOMRect(),
            message: 'Rephrase failed',
            onRetry,
            onClose: () => {},
        })
        const card = root.querySelector('.gf-rephrase--error')!
        expect(card.textContent).toContain('Rephrase failed')
        const retry = card.querySelector<HTMLElement>('[data-action="retry"]')!
        retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect(onRetry).toHaveBeenCalledTimes(1)
        expect(root.querySelector('.gf-rephrase--error')).toBeNull()
    })
})
