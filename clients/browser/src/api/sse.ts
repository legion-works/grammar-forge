// Minimal fetch-stream SSE parser. EventSource cannot POST, so the stream
// client reads the Response body and frames it itself. Only the subset of
// the SSE wire format the bridge emits is supported: `event:` + `data:`
// lines with blank-line framing; comments and id:/retry: fields are
// ignored. data-only blocks default to event "message" per the SSE spec.

export interface SSEEvent {
    event: string
    data: string
}

/** Incrementally parse an SSE byte stream into events. */
export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            for (;;) {
                const separator = buffer.indexOf('\n\n')
                if (separator < 0) break
                const block = buffer.slice(0, separator)
                buffer = buffer.slice(separator + 2)
                const event = parseEventBlock(block)
                if (event) yield event
            }
        }
        // A well-formed bridge stream ends with framing, but tolerate a
        // truncated tail so a final frame is never silently dropped.
        const tail = parseEventBlock(buffer)
        if (tail) yield tail
    } finally {
        reader.releaseLock()
    }
}

function parseEventBlock(block: string): SSEEvent | null {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
        else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart())
    }
    if (data.length === 0) return null
    return { event, data: data.join('\n') }
}
