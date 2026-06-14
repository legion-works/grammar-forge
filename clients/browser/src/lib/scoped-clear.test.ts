// @vitest-environment jsdom
// Unit tests for the Finding 5 short-circuit + the per-item clearItem
// loop. The behavior is also covered (at the orchestrator level) by
// the wiring-shape tests in content/index.test.ts and vencord
// orchestrator.test.ts; this file is the algorithmic test.
import { describe, expect, it, vi } from 'vitest'
import { applyScopedOverlayClear, type ClearableHighlightLayer } from '@/lib/scoped-clear'

function mkLayer(): ClearableHighlightLayer & {
    clearItem: ReturnType<typeof vi.fn<(i: number) => void>>
    reconcile: ReturnType<typeof vi.fn<(s: readonly never[]) => void>>
} {
    return {
        clearItem: vi.fn<(i: number) => void>(),
        reconcile: vi.fn<(s: readonly never[]) => void>(),
    }
}

describe('applyScopedOverlayClear (Finding 5)', () => {
    it('is a no-op when oldItems.length === kept.length', () => {
        const layer = mkLayer()
        const old = [{ id: 1 }, { id: 2 }]
        applyScopedOverlayClear(layer, old, old)
        expect(layer.clearItem).not.toHaveBeenCalled()
        expect(layer.reconcile).not.toHaveBeenCalled()
    })

    it('calls reconcile([]) exactly once when kept.length === 0 (Finding 5 fast path)', () => {
        const layer = mkLayer()
        const old = [{ id: 1 }, { id: 2 }, { id: 3 }]
        applyScopedOverlayClear(layer, old, [])
        expect(layer.reconcile).toHaveBeenCalledTimes(1)
        expect(layer.reconcile).toHaveBeenCalledWith([])
        // The per-item loop is the slow path; the short-circuit must
        // skip it entirely so the O(N × pool) walk never runs.
        expect(layer.clearItem).not.toHaveBeenCalled()
    })

    it('falls back to the per-item clearItem loop when kept.length > 0', () => {
        const layer = mkLayer()
        const a = { id: 1 }
        const b = { id: 2 }
        const c = { id: 3 }
        const old = [a, b, c]
        applyScopedOverlayClear(layer, old, [a, c])
        // b was dropped → clearItem(1) exactly once.
        expect(layer.clearItem).toHaveBeenCalledTimes(1)
        expect(layer.clearItem).toHaveBeenCalledWith(1)
        // Fast path NOT taken when there's a survivor.
        expect(layer.reconcile).not.toHaveBeenCalled()
    })

    it('single-item drop uses the per-item loop (kept has one survivor)', () => {
        const layer = mkLayer()
        const a = { id: 1 }
        const b = { id: 2 }
        applyScopedOverlayClear(layer, [a, b], [a])
        expect(layer.clearItem).toHaveBeenCalledTimes(1)
        expect(layer.clearItem).toHaveBeenCalledWith(1)
    })
})
