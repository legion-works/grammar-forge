// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createOverlayHost, type OverlayHost } from '@/overlay/shadow-host'
import { mountScanline, removeScanline } from '@/overlay/scanline'

const hosts: OverlayHost[] = []
function mkHost(): OverlayHost {
    const h = createOverlayHost()
    hosts.push(h)
    return h
}
afterEach(() => {
    for (const h of hosts.splice(0)) h.destroy()
    document.querySelectorAll('[data-grammarforge-overlay]').forEach((el) => el.remove())
    document.querySelectorAll('[data-grammarforge-scanline]').forEach((el) => el.remove())
})

// DOMRect constructor: new DOMRect(x, y, width, height). x → left, y → top.
// So this rect is left=200, top=100, width=480, height=120.
const FIELD_RECT = new DOMRect(200, 100, 480, 120)

describe('mountScanline', () => {
    it('appends exactly one wrapper + one .gf-scanline child in the host root', () => {
        const host = mkHost()
        mountScanline(host, FIELD_RECT)
        const wrappers = host.root.querySelectorAll('[data-grammarforge-scanline]')
        expect(wrappers).toHaveLength(1)
        const scanline = host.root.querySelector('.gf-scanline')
        expect(scanline).not.toBeNull()
        // the scanline is nested INSIDE the wrapper (containing block for
        // the keyframe's `top: -2%` / `top: 102%` percentages)
        expect(scanline?.parentElement).toBe(wrappers[0])
    })

    it('positions the wrapper from the field rect (fixed top/left/width/height)', () => {
        const host = mkHost()
        const handle = mountScanline(host, FIELD_RECT)
        const wrapper = host.root.querySelector<HTMLElement>('[data-grammarforge-scanline]')!
        expect(wrapper.style.position).toBe('fixed')
        // rect.top = 100 → style.top = '100px'; rect.left = 200 → style.left = '200px'
        expect(wrapper.style.top).toBe('100px')
        expect(wrapper.style.left).toBe('200px')
        expect(wrapper.style.width).toBe('480px')
        expect(wrapper.style.height).toBe('120px')
        // visual-only — must not block clicks on the field underneath
        expect(wrapper.style.pointerEvents).toBe('none')
        // aria-hidden so ATs don't announce a phantom sweep
        expect(wrapper.getAttribute('aria-hidden')).toBe('true')
        expect(handle.isMounted()).toBe(true)
    })

    it('update(fieldRect) rewrites the wrapper positioning in place', () => {
        const host = mkHost()
        const handle = mountScanline(host, FIELD_RECT)
        const wrapper = host.root.querySelector<HTMLElement>('[data-grammarforge-scanline]')!
        // Same node — update mutates, doesn't replace (so the .gf-scanline
        // child keeps its keyframe timeline; the line keeps sweeping).
        expect(wrapper).toBe(host.root.querySelector('[data-grammarforge-scanline]'))
        handle.update(new DOMRect(0, 0, 600, 80))
        expect(wrapper.style.top).toBe('0px')
        expect(wrapper.style.left).toBe('0px')
        expect(wrapper.style.width).toBe('600px')
        expect(wrapper.style.height).toBe('80px')
    })

    it('update is a no-op after the wrapper has been removed', () => {
        const host = mkHost()
        const handle = mountScanline(host, FIELD_RECT)
        handle.remove()
        // must NOT throw; must NOT re-attach the wrapper
        expect(() => handle.update(new DOMRect(0, 0, 1, 1))).not.toThrow()
        expect(host.root.querySelector('[data-grammarforge-scanline]')).toBeNull()
        expect(handle.isMounted()).toBe(false)
    })
})

describe('removeScanline', () => {
    it('detaches the wrapper from the shadow root', () => {
        const host = mkHost()
        const handle = mountScanline(host, FIELD_RECT)
        expect(host.root.querySelector('[data-grammarforge-scanline]')).not.toBeNull()
        removeScanline(handle)
        expect(host.root.querySelector('[data-grammarforge-scanline]')).toBeNull()
        expect(handle.isMounted()).toBe(false)
    })

    it('is idempotent (double-remove does not throw)', () => {
        const host = mkHost()
        const handle = mountScanline(host, FIELD_RECT)
        removeScanline(handle)
        expect(() => removeScanline(handle)).not.toThrow()
        expect(host.root.querySelector('[data-grammarforge-scanline]')).toBeNull()
    })

    it('does not interfere with the host or other surfaces on teardown', () => {
        // The scan-line wrapper is a pure child of the host's shadow root;
        // removing it must not affect the host or its other children
        // (popover, status button, etc.) — those are independent.
        const host = mkHost()
        const sibling = document.createElement('div')
        sibling.setAttribute('data-grammarforge-other', '')
        host.root.appendChild(sibling)
        const handle = mountScanline(host, FIELD_RECT)
        removeScanline(handle)
        expect(host.host.isConnected).toBe(true)
        expect(sibling.isConnected).toBe(true)
    })
})

describe('per-field scoping', () => {
    it('two simultaneous mounts (different fields) coexist in the same root', () => {
        const host = mkHost()
        // Simulate two fields in flight (the orchestrator keys the handle
        // on the per-field state, so two mounts is the supported shape).
        const a = mountScanline(host, new DOMRect(0, 0, 200, 50))
        const b = mountScanline(host, new DOMRect(0, 100, 200, 50))
        const wrappers = host.root.querySelectorAll('[data-grammarforge-scanline]')
        expect(wrappers).toHaveLength(2)
        expect(a.isMounted()).toBe(true)
        expect(b.isMounted()).toBe(true)
        // Removing one does not detach the other
        removeScanline(a)
        expect(host.root.querySelectorAll('[data-grammarforge-scanline]')).toHaveLength(1)
        expect(b.isMounted()).toBe(true)
    })
})

describe('measure-before-rerender contract', () => {
    it('mount with a zero-rect (post-mutation / detached) still produces a positioned wrapper', () => {
        // The rect passed in is the caller's PRE-measured rect. If the
        // caller measured BEFORE the rerender (the flows.md §3 gotcha),
        // the rect is live; if they measured AFTER, the rect is the
        // detached zero-rect. The helper takes the rect as supplied —
        // it doesn't re-measure. This test pins that contract: a zero
        // rect mounts at 0,0 (visible off-screen, not a crash), and the
        // caller's re-measure is their responsibility to issue via
        // `update`.
        const host = mkHost()
        const handle = mountScanline(host, new DOMRect(0, 0, 0, 0))
        const wrapper = host.root.querySelector<HTMLElement>('[data-grammarforge-scanline]')!
        expect(wrapper.style.top).toBe('0px')
        expect(wrapper.style.left).toBe('0px')
        expect(wrapper.style.width).toBe('0px')
        expect(wrapper.style.height).toBe('0px')
        // re-anchor with a live rect — the orchestrator does this on the
        // very next renderField, so a stale zero-rect is a 1-frame blip
        // (DOMRect constructor: new DOMRect(x, y, width, height))
        handle.update(new DOMRect(60, 50, 400, 80))
        expect(wrapper.style.top).toBe('50px')
        expect(wrapper.style.left).toBe('60px')
        expect(wrapper.style.width).toBe('400px')
        expect(wrapper.style.height).toBe('80px')
    })
})
