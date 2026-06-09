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

    it('renders the message and an action button', () => {
        const root = mkRoot()
        showToast(root, { message: 'Ignored', actionLabel: 'Undo', onAction: () => {} })
        const toast = root.querySelector('.gf-toast') as HTMLElement
        expect(toast).not.toBeNull()
        expect(toast.getAttribute('role')).toBe('status')
        expect(toast.querySelector('span')?.textContent).toBe('Ignored')
        const btn = toast.querySelector('button') as HTMLButtonElement
        expect(btn).not.toBeNull()
        expect(btn.classList.contains('gf-toast__action')).toBe(true)
        expect(btn.textContent).toBe('Undo')
    })

    it('fires onAction and dismisses when the action button is clicked', () => {
        const root = mkRoot()
        const onAction = vi.fn<() => void>()
        showToast(root, { message: 'Ignored', actionLabel: 'Undo', onAction })
        const btn = root.querySelector('.gf-toast__action') as HTMLButtonElement
        btn.click()
        expect(onAction).toHaveBeenCalledTimes(1)
        expect(root.querySelector('.gf-toast')).toBeNull()
    })

    it('auto-dismisses after the default duration (1200ms)', () => {
        const root = mkRoot()
        showToast(root, { message: 'Ignored', actionLabel: 'Undo', onAction: () => {} })
        expect(root.querySelector('.gf-toast')).not.toBeNull()
        vi.advanceTimersByTime(1199)
        expect(root.querySelector('.gf-toast')).not.toBeNull()
        vi.advanceTimersByTime(1)
        expect(root.querySelector('.gf-toast')).toBeNull()
    })

    it('auto-dismisses after a custom durationMs', () => {
        const root = mkRoot()
        showToast(root, {
            message: 'Ignored',
            actionLabel: 'Undo',
            onAction: () => {},
            durationMs: 500,
        })
        expect(root.querySelector('.gf-toast')).not.toBeNull()
        vi.advanceTimersByTime(500)
        expect(root.querySelector('.gf-toast')).toBeNull()
    })

    it('the action click cancels the auto-dismiss timer', () => {
        const root = mkRoot()
        const onAction = vi.fn<() => void>()
        showToast(root, { message: 'Ignored', actionLabel: 'Undo', onAction })
        const btn = root.querySelector('.gf-toast__action') as HTMLButtonElement
        btn.click()
        // Advance well past the default 1200ms — the click already removed the
        // node, so no further side-effect (and no late timer firing into a
        // detached node).
        vi.advanceTimersByTime(5000)
        expect(onAction).toHaveBeenCalledTimes(1)
        expect(root.querySelector('.gf-toast')).toBeNull()
    })

    it('keeps only one toast per root (the new one replaces the old)', () => {
        const root = mkRoot()
        showToast(root, { message: 'A', actionLabel: 'X', onAction: () => {} })
        showToast(root, { message: 'B', actionLabel: 'Y', onAction: () => {} })
        const toasts = root.querySelectorAll('.gf-toast')
        expect(toasts).toHaveLength(1)
        expect(toasts[0]!.querySelector('span')?.textContent).toBe('B')
    })

    it('dismiss() is a no-op once the toast is already gone', () => {
        const root = mkRoot()
        const h = showToast(root, { message: 'Ignored', actionLabel: 'Undo', onAction: () => {} })
        h.dismiss()
        expect(root.querySelector('.gf-toast')).toBeNull()
        // Second call must not throw (timer is null + node is detached).
        expect(() => h.dismiss()).not.toThrow()
    })
})
