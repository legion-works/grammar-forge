// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOverlayHost, isWithinOverlay, type OverlayHost } from '@/overlay/shadow-host'
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

describe('isWithinOverlay', () => {
    it('returns true for an element that IS the overlay host', () => {
        const host = document.createElement('div')
        host.setAttribute('data-grammarforge-overlay', '')
        document.body.appendChild(host)
        expect(isWithinOverlay(host)).toBe(true)
        host.remove()
    })

    it('returns true for an element nested inside the overlay host', () => {
        const host = document.createElement('div')
        host.setAttribute('data-grammarforge-overlay', '')
        const button = document.createElement('button')
        host.appendChild(button)
        document.body.appendChild(host)
        expect(isWithinOverlay(button)).toBe(true)
        host.remove()
    })

    it('returns false for an unrelated element (genuine field-exit)', () => {
        const other = document.createElement('div')
        document.body.appendChild(other)
        expect(isWithinOverlay(other)).toBe(false)
        other.remove()
    })

    it('returns false for null (relatedTarget absent — genuine exit)', () => {
        expect(isWithinOverlay(null)).toBe(false)
    })

    it('returns false for a non-Element EventTarget', () => {
        expect(isWithinOverlay(new EventTarget())).toBe(false)
    })
})

describe('onFieldBlur overlay-focus guard (browser)', () => {
    // This suite tests the BEHAVIOUR of the blur guard: when focus moves into
    // our overlay, highlights must be preserved; when focus moves elsewhere,
    // they must be cleared. We test via the isWithinOverlay helper (the
    // orchestrator's onFieldBlur calls it as its first guard) and a hand-rolled
    // mirror of the guard logic, since onFieldBlur is a closure inside start().
    it('preserves highlights when blur relatedTarget is inside the overlay host', () => {
        // Build a fake overlay host (mirrors what createOverlayHost produces)
        const overlayHost = document.createElement('div')
        overlayHost.setAttribute('data-grammarforge-overlay', '')
        const applyBtn = document.createElement('button')
        overlayHost.appendChild(applyBtn)
        document.body.appendChild(overlayHost)

        // Simulate the blur event whose relatedTarget is the Apply button
        // (shadow-boundary retargeting gives us the host; we set it directly
        // to the button here to also cover the nested-element case).
        const blurEvent = new FocusEvent('blur', { relatedTarget: applyBtn })

        // Mirror of the guard: if isWithinOverlay(e.relatedTarget) → skip teardown
        let highlightsCleared = false
        const mockReconcile = (): void => {
            highlightsCleared = true
        }
        const items = [{ id: 1 }, { id: 2 }]
        let itemsAfter = [...items]

        if (!isWithinOverlay(blurEvent.relatedTarget)) {
            itemsAfter = []
            mockReconcile()
        }

        expect(highlightsCleared).toBe(false)
        expect(itemsAfter).toHaveLength(2)

        overlayHost.remove()
    })

    it('clears highlights when blur relatedTarget is an unrelated element (genuine exit)', () => {
        const unrelated = document.createElement('input')
        document.body.appendChild(unrelated)

        const blurEvent = new FocusEvent('blur', { relatedTarget: unrelated })

        let highlightsCleared = false
        const mockReconcile = (): void => {
            highlightsCleared = true
        }
        const items = [{ id: 1 }, { id: 2 }]
        let itemsAfter = [...items]

        if (!isWithinOverlay(blurEvent.relatedTarget)) {
            itemsAfter = []
            mockReconcile()
        }

        expect(highlightsCleared).toBe(true)
        expect(itemsAfter).toHaveLength(0)

        unrelated.remove()
    })

    it('clears highlights when blur relatedTarget is null (tab away / window blur)', () => {
        const blurEvent = new FocusEvent('blur', { relatedTarget: null })

        let highlightsCleared = false
        const mockReconcile = (): void => {
            highlightsCleared = true
        }
        let itemsAfter = [{ id: 1 }, { id: 2 }]

        if (!isWithinOverlay(blurEvent.relatedTarget)) {
            itemsAfter = []
            mockReconcile()
        }

        expect(highlightsCleared).toBe(true)
        expect(itemsAfter).toHaveLength(0)
    })
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

    it('defines translucent per-category underline classes', () => {
        // W1-1 migration: the design-system .gf-u + .gf-u--<cat> family
        // replaces the legacy .gf-highlight / --focus / --hover ladder.
        // The .is-on class is the single hover/active indicator (no
        // separate --focus / --hover modifiers in the new design).
        expect(OVERLAY_CSS).toContain('.gf-u')
        expect(OVERLAY_CSS).toMatch(/\.gf-u--spelling\b/)
        expect(OVERLAY_CSS).toMatch(/\.gf-u--grammar\b/)
        expect(OVERLAY_CSS).toMatch(/\.gf-u--punctuation\b/)
        expect(OVERLAY_CSS).toMatch(/\.gf-u--style\b/)
        expect(OVERLAY_CSS).toMatch(/\.gf-u--typography\b/)
        expect(OVERLAY_CSS).toContain('.gf-u.is-on')
        // the per-category color is set via the --gf-cat-* custom properties,
        // and the .is-on tint paints via color-mix().
        expect(OVERLAY_CSS).toContain('--gf-cat-spelling')
        expect(OVERLAY_CSS).toMatch(/color-mix\(in srgb, var\(--gf-cat-spelling\)/)
    })

    it('.gf-u resting state has NO background tint (only on .is-on)', () => {
        // The resting visual is just the wavy underline — the background
        // tint must NOT be permanent. Extract the .gf-u rule body and
        // assert its background is transparent. The .gf-u.is-on rule is
        // where the tint ladder lives (now 22% per the SCSS tokens).
        const idle = OVERLAY_CSS.match(/\.gf-u\s*\{([\s\S]*?)\n\s*\}/)
        expect(idle).not.toBeNull()
        // Resting background is transparent.
        expect(idle![1]!).toMatch(/background:\s*transparent/)
        // The .is-on rule resolves to a 22% color-mix blend.
        const onRule = OVERLAY_CSS.match(/\.gf-u\.is-on\s*\{([\s\S]*?)\n\s*\}/)
        expect(onRule).not.toBeNull()
        expect(onRule![1]!).toMatch(/22%/)
    })
})
