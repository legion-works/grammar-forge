// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { debugLog, debugWarn, isDebugLoggingEnabled, setDebugLoggingEnabled } from '@/lib/debug-log'

afterEach(() => {
    setDebugLoggingEnabled(false)
    vi.restoreAllMocks()
})

describe('debugLog', () => {
    it('is a no-op when disabled (no console.debug)', () => {
        setDebugLoggingEnabled(false)
        const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
        debugLog('scope', 'message', { a: 1 })
        expect(spy).not.toHaveBeenCalled()
    })

    it('logs a namespaced line when enabled', () => {
        setDebugLoggingEnabled(true)
        const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
        debugLog('highlight', 'native setFieldHighlights', { count: 3 })
        expect(spy).toHaveBeenCalledTimes(1)
        const [msg, data] = spy.mock.calls[0]!
        expect(msg).toBe('[gf] highlight: native setFieldHighlights')
        expect(data).toEqual({ count: 3 })
    })

    it('omits the data arg when none is given', () => {
        setDebugLoggingEnabled(true)
        const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
        debugLog('field', 'attach')
        expect(spy).toHaveBeenCalledWith('[gf] field: attach')
    })

    it('isDebugLoggingEnabled reflects the flag', () => {
        setDebugLoggingEnabled(true)
        expect(isDebugLoggingEnabled()).toBe(true)
        setDebugLoggingEnabled(false)
        expect(isDebugLoggingEnabled()).toBe(false)
    })
})

describe('debugWarn', () => {
    it('always warns regardless of the debug flag', () => {
        setDebugLoggingEnabled(false)
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        debugWarn('check', 'correct() failed', new Error('boom'))
        expect(spy).toHaveBeenCalledTimes(1)
        const [msg] = spy.mock.calls[0]!
        expect(msg).toBe('[gf] check: correct() failed')
    })
})
