// clients/browser/src/storage/settings-core-cross-client.test.ts
// Cross-client invariant: the common fields (bridgeUrl, realtimeDelayMs,
// allowRemoteBridge) are validated identically across the Vencord,
// OpenCode, and browser clients. The shared resolver is the single
// source of truth; this test pins the behavior the three clients rely
// on. If a future change diverges (e.g. vencord adopting a different
// floor), the test catches it and forces a deliberate update.

import { describe, expect, it } from 'vitest'
import { resolveCommonSettings, resolveCommonSettingsWithFloor } from './settings-core'

describe('shared core cross-client invariants', () => {
    it('empty input → all three clients see the same defaults', () => {
        const c = resolveCommonSettings({})
        expect(c.common).toEqual({
            bridgeUrl: 'http://localhost:8000',
            realtimeDelayMs: 500,
            allowRemoteBridge: false,
        })
    })
    it('bridge URL trailing slash is stripped identically for all clients', () => {
        expect(resolveCommonSettings({ bridgeUrl: 'http://x/' }).common.bridgeUrl).toBe('http://x')
    })
    it('vencord floor (150ms) is the only divergence; the core resolver exposes it via withFloor', () => {
        const withFloor = resolveCommonSettingsWithFloor({ realtimeDelayMs: 10 }, 150)
        expect(withFloor.common.realtimeDelayMs).toBe(150)
        // The other two clients (browser, opencode) accept 10ms — the
        // shared core WITHOUT the floor passes it through. Vencord is
        // the one that opts into the floor.
        const withoutFloor = resolveCommonSettings({ realtimeDelayMs: 10 })
        expect(withoutFloor.common.realtimeDelayMs).toBe(10)
    })
    it('allowRemoteBridge is strict === true across all clients', () => {
        for (const v of [true, 1, 'true', '1', null, undefined] as const) {
            const out = resolveCommonSettings({ allowRemoteBridge: v })
            expect(out.common.allowRemoteBridge).toBe(v === true)
        }
    })
})
