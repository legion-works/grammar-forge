// @vitest-environment node
// Unit tests for the fetch-stream SSE parser. jsdom has no fetch/ReadableStream
// by default, so this file runs in node to exercise the real Web Streams API.

import { describe, expect, it } from 'vitest'
import { parseSSEStream, type SSEEvent } from '@/api/sse'

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder()
    return new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(enc.encode(c))
            controller.close()
        },
    })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SSEEvent[]> {
    const out: SSEEvent[] = []
    for await (const ev of parseSSEStream(body)) out.push(ev)
    return out
}

describe('parseSSEStream', () => {
    it('parses two events in one chunk', async () => {
        const events = await collect(
            streamOf('event: fast\ndata: {"a":1}\n\nevent: final\ndata: {"b":2}\n\n'),
        )
        expect(events).toEqual([
            { event: 'fast', data: '{"a":1}' },
            { event: 'final', data: '{"b":2}' },
        ])
    })

    it('reassembles an event split across chunk boundaries', async () => {
        const events = await collect(
            streamOf('event: fa', 'st\ndata: {"a"', ':1}\n', '\nevent: final\ndata: {}\n\n'),
        )
        expect(events).toEqual([
            { event: 'fast', data: '{"a":1}' },
            { event: 'final', data: '{}' },
        ])
    })

    it('yields a trailing event without final blank-line framing', async () => {
        const events = await collect(streamOf('event: final\ndata: {"x":1}'))
        expect(events).toEqual([{ event: 'final', data: '{"x":1}' }])
    })

    it('ignores comments and id/retry fields; defaults event to message', async () => {
        const events = await collect(streamOf(': comment\nid: 3\nretry: 100\ndata: hello\n\n'))
        expect(events).toEqual([{ event: 'message', data: 'hello' }])
    })

    it('skips blocks without data', async () => {
        const events = await collect(streamOf('event: ping\n\ndata: real\n\n'))
        expect(events).toEqual([{ event: 'message', data: 'real' }])
    })

    it('P1-6: strips a trailing \\r left by CRLF framing so data is valid JSON', async () => {
        // CRLF framing: "event: final\r\ndata: {\"a\":1}\r\n\r\n". The
        // block/blank-line boundary is matched on '\n\n', which leaves a
        // trailing \r attached to each line ("event: final\r" / 'data: {"a":1}\r').
        // Un-fixed, the \r used to survive into `data` (only trimStart was
        // applied) and corrupt JSON.parse.
        const events = await collect(streamOf('event: final\r\ndata: {"a":1}\r\n\r\n'))
        expect(events).toEqual([{ event: 'final', data: '{"a":1}' }])
        expect(() => JSON.parse(events[0]!.data)).not.toThrow()
    })

    it('P1-6: CRLF framing across multiple data: lines joins clean (no embedded \\r)', async () => {
        const events = await collect(streamOf('data: line1\r\ndata: line2\r\n\r\n'))
        expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }])
    })
})
