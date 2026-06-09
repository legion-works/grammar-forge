// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOverlayHost, type OverlayHost } from '@/overlay/shadow-host'
import { showPopover, type PopoverOptions } from '@/overlay/popover'
import { OVERLAY_CSS } from '@/overlay/styles'

const ANCHOR = new DOMRect(100, 100, 80, 16)

const createdHosts: OverlayHost[] = []
function mkHost(): OverlayHost {
    const h = createOverlayHost()
    createdHosts.push(h)
    return h
}
afterEach(() => {
    for (const h of createdHosts.splice(0)) h.destroy()
    document.querySelectorAll('[data-grammarforge-overlay]').forEach((el) => el.remove())
})

describe('createOverlayHost', () => {
    it('appends a host on document.body and attaches an open shadow root', () => {
        const host = mkHost()
        expect(host.host.isConnected).toBe(true)
        expect(host.host.getAttribute('data-grammarforge-overlay')).toBe('')
        expect(host.root).toBe(host.host.shadowRoot)
        expect(host.root.mode).toBe('open')
        // the stylesheet is injected into the shadow root
        const style = host.root.querySelector('style')
        expect(style).not.toBeNull()
        expect(style?.textContent).toBe(OVERLAY_CSS)
    })

    it('positions the host so fixed children anchor to the viewport', () => {
        const { host } = mkHost()
        // No transform/filter ancestor: the inline cssText must NOT include
        // either (otherwise fixed-position popovers anchor to the host, not
        // the viewport).
        expect(host.style.transform).toBe('')
        expect(host.style.filter).toBe('')
        expect(host.style.position).toBe('absolute')
        expect(host.style.pointerEvents).toBe('none')
        expect(host.style.zIndex).toBe('2147483647')
    })

    it('destroy() removes the host from the DOM', () => {
        const host = mkHost()
        const el = host.host
        host.destroy()
        expect(el.isConnected).toBe(false)
    })

    it('destroy() is idempotent', () => {
        const host = mkHost()
        host.destroy()
        expect(() => host.destroy()).not.toThrow()
        expect(host.isDestroyed()).toBe(true)
    })
})

describe('createOverlayHost teardown (popover listener + timer leak)', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    function mkPopoverOpts(): PopoverOptions {
        return {
            anchorRect: ANCHOR,
            category: 'spelling',
            message: 'm',
            diffOriginal: 'x',
            diffCorrected: 'y',
            diffIsDeletion: false,
            replacements: ['x'],
            onApply: vi.fn<(i: number) => void>(),
            onIgnore: vi.fn<() => void>(),
            onAddToDictionary: vi.fn<(w: string) => void>(),
        }
    }

    it('destroy() while a popover is open removes the document-level mousedown listener', () => {
        vi.useFakeTimers()
        const host = mkHost()
        const handle = showPopover(host.root, mkPopoverOpts())
        expect(handle.isOpen()).toBe(true)
        // advance past the 100ms mount delay so the outside-click listener
        // is actually installed
        vi.advanceTimersByTime(150)
        // spy on document.removeEventListener so we can assert the cleanup
        const removeSpy = vi.spyOn(document, 'removeEventListener')
        host.destroy()
        // the outside-click handler must have been removed
        const mousedownRemovals = removeSpy.mock.calls.filter((c) => c[0] === 'mousedown')
        expect(mousedownRemovals.length).toBeGreaterThan(0)
        // and the popover must be closed
        expect(handle.isOpen()).toBe(false)
        // dispatching a click on document afterwards is a no-op (no error)
        expect(() =>
            document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
        ).not.toThrow()
    })

    it('destroy() clears the mount-delay setTimeout (no late listener install)', () => {
        vi.useFakeTimers()
        const host = mkHost()
        showPopover(host.root, mkPopoverOpts())
        // the timer is scheduled but the listener is NOT yet attached
        const addSpy = vi.spyOn(document, 'addEventListener')
        host.destroy()
        const addCountBefore = addSpy.mock.calls.length
        // advance past the 100ms mount delay
        vi.advanceTimersByTime(500)
        const addCountAfter = addSpy.mock.calls.length
        // no new document-level mousedown listener was added after destroy
        expect(addCountAfter).toBe(addCountBefore)
    })

    it('destroy() removes the host from the DOM even if no popover was ever opened', () => {
        const host = mkHost()
        host.destroy()
        expect(host.host.isConnected).toBe(false)
        expect(document.querySelectorAll('[data-grammarforge-overlay]')).toHaveLength(0)
    })
})

describe('OVERLAY_CSS (Liquid Glass contract)', () => {
    it('uses backdrop-filter with the -webkit- prefix', () => {
        expect(OVERLAY_CSS).toContain('-webkit-backdrop-filter')
        expect(OVERLAY_CSS).toContain('backdrop-filter')
    })

    it('upgrades inside an @supports gate that recognises both prefixes', () => {
        // must cover both -webkit- and unprefixed, and base style must be solid
        expect(OVERLAY_CSS).toMatch(
            /@supports\s*\(\(backdrop-filter:\s*blur\(1px\)\)\s*or\s*\(-webkit-backdrop-filter:\s*blur\(1px\)\)\)/,
        )
    })

    it('falls back to a near-opaque solid scrim by default (no backdrop-filter without @supports)', () => {
        // the panel + pill must declare a solid base color before the @supports
        // upgrade so that browsers without backdrop-filter still read clearly.
        expect(OVERLAY_CSS).toMatch(/background:\s*rgba\(28,\s*28,\s*30,\s*0\.78\)/)
    })

    it('degrades under prefers-reduced-transparency: reduce', () => {
        expect(OVERLAY_CSS).toMatch(/@media\s*\(prefers-reduced-transparency:\s*reduce\)/)
        // the rule must reset backdrop-filter to none and bump the scrim
        const block = OVERLAY_CSS.match(
            /@media\s*\(prefers-reduced-transparency:\s*reduce\)\s*\{[^}]*\}/,
        )
        expect(block?.[0]).toContain('backdrop-filter: none')
        expect(block?.[0]).toMatch(/background:\s*color-mix/)
    })

    it('uses the additive pattern for users who opt into translucency', () => {
        expect(OVERLAY_CSS).toMatch(/@media\s*\(prefers-reduced-transparency:\s*no-preference\)/)
    })

    it('degrades under prefers-reduced-motion: reduce (no spring/scale)', () => {
        const block = OVERLAY_CSS.match(
            /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\s*\}/,
        )
        expect(block).not.toBeNull()
        // no transform is animated in the reduced-motion branch
        expect(block?.[0]).toMatch(/animation-duration:\s*1ms/)
    })

    it('animates only transform + opacity (never backdrop-filter)', () => {
        // no keyframes that touch backdrop-filter
        expect(OVERLAY_CSS).not.toMatch(/@keyframes[^{]*\{[^}]*backdrop-filter/)
        // the enter animation only transitions transform + opacity
        const enterBlock = OVERLAY_CSS.match(/@keyframes\s+gf-popover-enter\s*\{[^}]*\}/)
        expect(enterBlock?.[0]).toContain('transform:')
        expect(enterBlock?.[0]).toContain('opacity:')
    })

    it('defines translucent per-category highlight classes', () => {
        // base + intensity modifiers must each be present
        expect(OVERLAY_CSS).toContain('.gf-highlight')
        expect(OVERLAY_CSS).toContain('.gf-highlight--focus')
        expect(OVERLAY_CSS).toContain('.gf-highlight--hover')
        // the per-category color is set via the --gf-hl custom property, and
        // the highlight paints a translucent tint via color-mix().
        expect(OVERLAY_CSS).toContain('--gf-hl')
        expect(OVERLAY_CSS).toMatch(/color-mix\(in srgb, var\(--gf-hl/)
    })

    it('.gf-highlight uses color-mix alpha for the per-state tint ladder', () => {
        // Extract the .gf-highlight, .gf-highlight--focus, .gf-highlight--hover
        // rule bodies and assert the alpha ladder is 20% / 24% / 42%. This
        // ladder MUST match the native-highlight.ts IDLE/STRONG/HOVER_ALPHA
        // constants (contenteditable path) or the two renderers diverge.
        const idle = OVERLAY_CSS.match(/\.gf-highlight\s*\{([\s\S]*?)\n\s*\}/)
        const focus = OVERLAY_CSS.match(/\.gf-highlight--focus\s*\{([\s\S]*?)\n\s*\}/)
        const hover = OVERLAY_CSS.match(/\.gf-highlight--hover\s*\{([\s\S]*?)\n\s*\}/)
        expect(idle).not.toBeNull()
        expect(focus).not.toBeNull()
        expect(hover).not.toBeNull()
        expect(idle![1]!).toMatch(/20%/)
        expect(focus![1]!).toMatch(/24%/)
        expect(hover![1]!).toMatch(/42%/)
    })
})
