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
})
