// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { debugLog, debugWarn, isDebugLoggingEnabled, setDebugLoggingEnabled } from '@/lib/debug-log'

afterEach(() => {
    setDebugLoggingEnabled(null)
    try {
        localStorage.removeItem('gfDebug')
    } catch {
        // ignore
    }
    vi.restoreAllMocks()
})

describe('debugLog', () => {
    it('is a no-op when disabled (no console.log)', () => {
        setDebugLoggingEnabled(false)
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
        debugLog('scope', 'message', { a: 1 })
        expect(spy).not.toHaveBeenCalled()
    })

    it('logs a namespaced line at console.log (Info) level when enabled', () => {
        setDebugLoggingEnabled(true)
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
        debugLog('highlight', 'native setFieldHighlights', { count: 3 })
        expect(spy).toHaveBeenCalledTimes(1)
        const [msg, data] = spy.mock.calls[0]!
        expect(msg).toBe('[gf] highlight: native setFieldHighlights')
        expect(data).toEqual({ count: 3 })
    })

    it('omits the data arg when none is given', () => {
        setDebugLoggingEnabled(true)
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
        debugLog('field', 'attach')
        expect(spy).toHaveBeenCalledWith('[gf] field: attach')
    })

    it('reads the localStorage flag fresh when no override is set (no reload needed)', () => {
        setDebugLoggingEnabled(null) // fall back to localStorage
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
        debugLog('field', 'before')
        expect(spy).not.toHaveBeenCalled()
        localStorage.setItem('gfDebug', '1')
        debugLog('field', 'after')
        expect(spy).toHaveBeenCalledWith('[gf] field: after')
    })

    it('treats gfDebug values "" and "0" as disabled', () => {
        setDebugLoggingEnabled(null)
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
        localStorage.setItem('gfDebug', '0')
        debugLog('field', 'zero')
        localStorage.setItem('gfDebug', '')
        debugLog('field', 'empty')
        expect(spy).not.toHaveBeenCalled()
    })

    it('isDebugLoggingEnabled reflects the override flag', () => {
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
