// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showToast } from '@/overlay/toast'

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}

describe('showToast', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('renders the message and an action button styled as .gf-btn-soft', () => {
        const root = mkRoot()
        showToast(root, { message: 'Ignored', actionLabel: 'Undo', onAction: () => {} })
        const toast = root.querySelector('.gf-toast') as HTMLElement
        expect(toast).not.toBeNull()
        expect(toast.getAttribute('role')).toBe('status')
        const btn = toast.querySelector('button') as HTMLButtonElement
        expect(btn).not.toBeNull()
        expect(btn.classList.contains('gf-btn-soft')).toBe(true)
        expect(btn.classList.contains('gf-toast__action')).toBe(false)
        expect(btn.textContent).toBe('Undo')
    })

    it('renders the primary message in .gf-toast__text', () => {
        const root = mkRoot()
        showToast(root, { message: 'Won\u2019t flag this again', onAction: () => {} })
        const text = root.querySelector('.gf-toast__text') as HTMLElement
        expect(text).not.toBeNull()
        expect(text.textContent).toBe('Won\u2019t flag this again')
    })

    it('renders the sub line in .gf-toast__sub when subText is provided', () => {
        const root = mkRoot()
        showToast(root, {
            message: 'Accepted',
            subText: 'Grammar rule \u00b7 signal sent',
            onAction: () => {},
        })
        const sub = root.querySelector('.gf-toast__sub') as HTMLElement
        expect(sub).not.toBeNull()
        expect(sub.textContent).toBe('Grammar rule \u00b7 signal sent')
    })

    it('omits .gf-toast__sub when no subText is provided', () => {
        const root = mkRoot()
        showToast(root, { message: 'Accepted', onAction: () => {} })
        expect(root.querySelector('.gf-toast__sub')).toBeNull()
    })

    it('renders the leading icon emoji in .gf-toast__icon when provided', () => {
        const root = mkRoot()
        showToast(root, { message: 'Accepted', icon: '\u2728', onAction: () => {} })
        const icon = root.querySelector('.gf-toast__icon') as HTMLElement
        expect(icon).not.toBeNull()
        expect(icon.textContent).toBe('\u2728')
    })

    it('omits the icon span when no icon is provided', () => {
        const root = mkRoot()
        showToast(root, { message: 'Accepted', onAction: () => {} })
        expect(root.querySelector('.gf-toast__icon')).toBeNull()
    })

    it('fires onUndo and dismisses when the Undo button is clicked', () => {
        const root = mkRoot()
        const onUndo = vi.fn<() => void>()
        showToast(root, { message: 'Ignored', onUndo })
        const btn = root.querySelector('button') as HTMLButtonElement
        btn.click()
        expect(onUndo).toHaveBeenCalledTimes(1)
        expect(root.querySelector('.gf-toast')).toBeNull()
    })

    it('treats onAction as a back-compat alias for onUndo (still fires on click)', () => {
        const root = mkRoot()
        const onAction = vi.fn<() => void>()
        showToast(root, { message: 'Ignored', onAction })
        const btn = root.querySelector('button') as HTMLButtonElement
        btn.click()
        expect(onAction).toHaveBeenCalledTimes(1)
        expect(root.querySelector('.gf-toast')).toBeNull()
    })

    it('prefers onUndo over onAction when both are passed', () => {
        const root = mkRoot()
        const onAction = vi.fn<() => void>()
        const onUndo = vi.fn<() => void>()
        showToast(root, { message: 'Ignored', onAction, onUndo })
        const btn = root.querySelector('button') as HTMLButtonElement
        btn.click()
        expect(onUndo).toHaveBeenCalledTimes(1)
        expect(onAction).not.toHaveBeenCalled()
    })

    it('auto-dismisses after the default duration (1200ms) and fires onDismiss', () => {
        const root = mkRoot()
        const onDismiss = vi.fn<() => void>()
        showToast(root, { message: 'Ignored', onAction: () => {}, onDismiss })
        expect(root.querySelector('.gf-toast')).not.toBeNull()
        vi.advanceTimersByTime(1199)
        expect(root.querySelector('.gf-toast')).not.toBeNull()
        expect(onDismiss).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(root.querySelector('.gf-toast')).toBeNull()
        expect(onDismiss).toHaveBeenCalledTimes(1)
    })

    it('auto-dismisses after a custom durationMs and fires onDismiss', () => {
        const root = mkRoot()
        const onDismiss = vi.fn<() => void>()
        showToast(root, {
            message: 'Ignored',
            onAction: () => {},
            onDismiss,
            durationMs: 500,
        })
        expect(root.querySelector('.gf-toast')).not.toBeNull()
        vi.advanceTimersByTime(500)
        expect(root.querySelector('.gf-toast')).toBeNull()
        expect(onDismiss).toHaveBeenCalledTimes(1)
    })

    it('the Undo click cancels the auto-dismiss timer and does NOT fire onDismiss', () => {
        const root = mkRoot()
        const onDismiss = vi.fn<() => void>()
        showToast(root, { message: 'Ignored', onAction: () => {}, onDismiss })
        const btn = root.querySelector('button') as HTMLButtonElement
        btn.click()
        vi.advanceTimersByTime(5000)
        expect(onDismiss).not.toHaveBeenCalled()
    })

    it('manual dismiss() fires onDismiss exactly once (idempotent)', () => {
        const root = mkRoot()
        const onDismiss = vi.fn<() => void>()
        const h = showToast(root, { message: 'Ignored', onAction: () => {}, onDismiss })
        h.dismiss()
        expect(onDismiss).toHaveBeenCalledTimes(1)
        expect(() => h.dismiss()).not.toThrow()
        expect(onDismiss).toHaveBeenCalledTimes(1)
    })

    it('manual dismiss() cancels the auto-dismiss timer — timer callback is a no-op', () => {
        const root = mkRoot()
        const onDismiss = vi.fn<() => void>()
        const h = showToast(root, {
            message: 'Ignored',
            onAction: () => {},
            onDismiss,
            durationMs: 500,
        })
        // Manual dismiss fires onDismiss once and clears the timer.
        h.dismiss()
        expect(onDismiss).toHaveBeenCalledTimes(1)
        // Advance well past the original auto-dismiss — the cleared timer's
        // callback must not fire into a detached node and must not
        // double-report onDismiss.
        vi.advanceTimersByTime(5000)
        expect(onDismiss).toHaveBeenCalledTimes(1)
        expect(root.querySelector('.gf-toast')).toBeNull()
    })

    it('keeps only one toast per root (the new one replaces the old)', () => {
        const root = mkRoot()
        showToast(root, { message: 'A', onAction: () => {} })
        showToast(root, { message: 'B', onAction: () => {} })
        const toasts = root.querySelectorAll('.gf-toast')
        expect(toasts).toHaveLength(1)
        expect(toasts[0]!.querySelector('.gf-toast__text')?.textContent).toBe('B')
    })
})
