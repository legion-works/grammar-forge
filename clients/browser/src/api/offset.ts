import type { ByteSpan } from '@/api/types'

const encoder = new TextEncoder()

function utf8Len(cp: number): number {
    if (cp < 0x80) return 1
    if (cp < 0x800) return 2
    if (cp < 0x10000) return 3
    return 4
}

/**
 * Map a UTF-8 byte offset into a UTF-16 code-unit (JS string) index for `text`.
 * Throws if the offset is out of range or lands inside a multi-byte sequence
 * (a mid-codepoint boundary is a bug — the caller must drop the suggestion).
 */
export function byteToCodeUnit(text: string, byteOffset: number): number {
    if (byteOffset < 0) throw new RangeError('negative byte offset')
    if (byteOffset === 0) return 0
    let bytes = 0
    let i = 0
    while (i < text.length) {
        const cp = text.codePointAt(i)!
        const len = utf8Len(cp)
        if (bytes + len > byteOffset) {
            throw new RangeError(`byte offset ${byteOffset} lands mid-codepoint`)
        }
        bytes += len
        i += cp > 0xffff ? 2 : 1
        if (bytes === byteOffset) return i
    }
    if (bytes === byteOffset) return text.length
    throw new RangeError(`byte offset ${byteOffset} exceeds text (${bytes} bytes)`)
}

/**
 * Convert a byte span to a code-unit span and verify the round-trip: the
 * UTF-8 encoding of the resulting substring must have exactly (end-start)
 * bytes. Returns null on any failure so the caller drops the suggestion.
 * Never normalises `text`.
 */
export function verifyByteSpan(
    text: string,
    span: ByteSpan,
): { start: number; end: number } | null {
    try {
        const start = byteToCodeUnit(text, span.start)
        const end = byteToCodeUnit(text, span.end)
        if (end < start) return null
        const sliceBytes = encoder.encode(text.slice(start, end)).length
        if (sliceBytes !== span.end - span.start) return null
        return { start, end }
    } catch {
        return null
    }
}

/** Hard cap on the verify cache size. The bridge issues
 *  monotonically-increasing suggestion ids within a session and the
 *  investigation showed it never recycles them; once the cache hits
 *  this many entries the OLDEST is evicted (FIFO — Map iteration
 *  order is insertion order). The evicted entry's id is almost
 *  certainly not going to be re-verified (the next check uses a new
 *  span), so the loss is safe. 4096 ≈ 30min of dense correction
 *  traffic at 1 suggestion/sec — well past the typical session. */
const VERIFY_CACHE_CAP = 4096

/**
 * Verify a byte span with a per-suggestion-id memo. The plan's P1 fix:
 * `verifyByteSpan` is O(N) (a from-index-0 walk over the text via
 * `byteToCodeUnit`); on a 30k-char draft with K suggestions that's
 * O(N×K) per check. For unchanged text the byte→code-unit mapping is
 * stable, so we cache the result keyed on `(suggestionId, textHash)`
 * and short-circuit subsequent calls. The cache is module-scoped
 * (one entry per suggestion id, bounded by `VERIFY_CACHE_CAP`); the
 * bridge's per-sentence eviction handles long-term cleanup.
 *
 * `suggestionId === undefined` short-circuits to a direct `verify`
 * call (the preview path: id-less fast frames must bypass the cache
 * so the existing `TestCorrectStagedEmitsFastPreviewThenFinal`
 * contract — preview ids are zero — stays byte-identical).
 */
const verifyCache = new Map<
    number,
    { hash: string; result: { start: number; end: number } | null }
>()

export function verifyByteSpanWithCache(
    text: string,
    span: ByteSpan,
    suggestionId: number | undefined,
    textHash: string,
    verify: (t: string, s: ByteSpan) => { start: number; end: number } | null = verifyByteSpan,
): { start: number; end: number } | null {
    if (suggestionId === undefined) return verify(text, span)
    const cached = verifyCache.get(suggestionId)
    if (cached && cached.hash === textHash) return cached.result
    const result = verify(text, span)
    verifyCache.set(suggestionId, { hash: textHash, result })
    if (verifyCache.size > VERIFY_CACHE_CAP) {
        // FIFO eviction: Map preserves insertion order, so the first
        // key is the oldest. Safe because the bridge id is monotonic
        // (older ids won't be re-verified — the next check generates
        // a new id range).
        const oldest = verifyCache.keys().next().value
        if (oldest !== undefined) verifyCache.delete(oldest)
    }
    return result
}

export function clearVerifyCache(): void {
    verifyCache.clear()
}

/** Exposed for tests; not part of the public API. */
export const __VERIFY_CACHE_CAP = VERIFY_CACHE_CAP
/** Exposed for tests; not part of the public API. */
export function __verifyCacheSize(): number {
    return verifyCache.size
}
