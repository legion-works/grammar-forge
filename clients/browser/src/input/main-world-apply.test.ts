// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    APPLY_PAYLOAD_ATTR,
    APPLY_RESULT_ATTR,
    installMainWorldApplyAgent,
    requestMainWorldApply,
} from './main-world-apply'
import type { CodeUnitSpan } from './text'

// jsdom has a single JS world, so agent + requester share it here — the
// tests exercise the PROTOCOL (attribute payloads, event flow, timeout,
// id correlation, cleanup), not the world isolation itself.

type ApplyFn = (el: HTMLElement, span: CodeUnitSpan, replacement: string) => Promise<boolean>

let uninstall: (() => void) | null = null

afterEach(() => {
    uninstall?.()
    uninstall = null
    document.body.innerHTML = ''
})

function makeField(): HTMLElement {
    const el = document.createElement('div')
    el.setAttribute('contenteditable', 'true')
    el.textContent = 'hello world'
    document.body.appendChild(el)
    return el
}

describe('main-world apply protocol', () => {
    it('round-trips a successful apply and cleans up attributes', async () => {
        const apply = vi.fn<ApplyFn>().mockResolvedValue(true)
        uninstall = installMainWorldApplyAgent({ apply })
        const el = makeField()
        const ok = await requestMainWorldApply(el, { start: 0, end: 5 }, 'howdy', 500)
        expect(ok).toBe(true)
        expect(apply).toHaveBeenCalledWith(el, { start: 0, end: 5 }, 'howdy')
        expect(el.hasAttribute(APPLY_PAYLOAD_ATTR)).toBe(false)
        expect(el.hasAttribute(APPLY_RESULT_ATTR)).toBe(false)
    })

    it('reports agent-side failure as false', async () => {
        const apply = vi.fn<ApplyFn>().mockResolvedValue(false)
        uninstall = installMainWorldApplyAgent({ apply })
        const el = makeField()
        await expect(requestMainWorldApply(el, { start: 0, end: 1 }, 'x', 500)).resolves.toBe(false)
    })

    it('reports an agent-side throw as false', async () => {
        const apply = vi.fn<ApplyFn>().mockRejectedValue(new Error('boom'))
        uninstall = installMainWorldApplyAgent({ apply })
        const el = makeField()
        await expect(requestMainWorldApply(el, { start: 0, end: 1 }, 'x', 500)).resolves.toBe(false)
    })

    it('times out to false when no agent is installed', async () => {
        const el = makeField()
        const ok = await requestMainWorldApply(el, { start: 0, end: 1 }, 'x', 50)
        expect(ok).toBe(false)
        expect(el.hasAttribute(APPLY_PAYLOAD_ATTR)).toBe(false)
    })

    it('ignores a stale result for a different request id', async () => {
        const el = makeField()
        // No agent; plant a stale result attribute + event mid-flight.
        const pending = requestMainWorldApply(el, { start: 0, end: 1 }, 'x', 80)
        el.setAttribute(APPLY_RESULT_ATTR, JSON.stringify({ id: 'someone-else', ok: true }))
        el.dispatchEvent(new CustomEvent('grammarforge:apply-result'))
        // The stale reply must NOT resolve the request; the timeout does.
        await expect(pending).resolves.toBe(false)
    })

    it('install is idempotent per document', async () => {
        const apply = vi.fn<ApplyFn>().mockResolvedValue(true)
        uninstall = installMainWorldApplyAgent({ apply })
        const second = installMainWorldApplyAgent({ apply })
        const el = makeField()
        await requestMainWorldApply(el, { start: 0, end: 5 }, 'howdy', 500)
        // One agent listener => exactly one apply call.
        expect(apply).toHaveBeenCalledTimes(1)
        second()
    })
})
