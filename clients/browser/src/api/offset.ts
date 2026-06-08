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
