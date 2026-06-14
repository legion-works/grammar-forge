// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    createConsoleBackend,
    createFileBackend,
    createLocalStorageOverrideBackend,
} from './debug-backends'

beforeEach(() => {
    try {
        localStorage.removeItem('gfDebug')
    } catch {
        // ignore
    }
})
afterEach(() => {
    try {
        localStorage.removeItem('gfDebug')
    } catch {
        // ignore
    }
})

describe('createConsoleBackend', () => {
    it('logs a single line "[prefix] scope: message" when no data', () => {
        const log = vi.fn<(...args: unknown[]) => void>()
        const warn = vi.fn<(...args: unknown[]) => void>()
        const b = createConsoleBackend({ prefix: '[gf]', out: { log, warn } })
        b.log('info', 'highlight', 'attach')
        expect(log).toHaveBeenCalledWith('[gf] highlight: attach')
    })
    it('logs a two-arg line "[prefix] scope: message" + data when data is given', () => {
        const log = vi.fn<(...args: unknown[]) => void>()
        const b = createConsoleBackend({
            prefix: '[gf]',
            out: { log, warn: vi.fn<(...args: unknown[]) => void>() },
        })
        b.log('info', 'pill', 'render', { count: 3 })
        expect(log).toHaveBeenCalledWith('[gf] pill: render', { count: 3 })
    })
    it('routes warn to the warn sink', () => {
        const log = vi.fn<(...args: unknown[]) => void>()
        const warn = vi.fn<(...args: unknown[]) => void>()
        const b = createConsoleBackend({ prefix: '[gf]', out: { log, warn } })
        b.log('warn', 'check', 'bridge failed')
        expect(warn).toHaveBeenCalledWith('[gf] check: bridge failed')
        expect(log).not.toHaveBeenCalled()
    })
    it('honors the isEnabled override (returns false → no-op)', () => {
        const log = vi.fn<(...args: unknown[]) => void>()
        const b = createConsoleBackend({
            isEnabled: () => false,
            out: { log, warn: vi.fn<(...args: unknown[]) => void>() },
        })
        expect(b.enabled()).toBe(false)
        b.log('info', 'x', 'y')
        expect(log).not.toHaveBeenCalled()
    })
})

describe('createFileBackend', () => {
    it('appends a single ISO-8601-prefixed line per call', () => {
        const append = vi.fn<(...args: unknown[]) => void>()
        const b = createFileBackend({
            path: '/tmp/x.log',
            isEnabled: () => true,
            append,
            nowIso: () => '2026-06-13T12:00:00.000Z',
        })
        b.log('info', 'check', 'start', { seq: 1 })
        expect(append).toHaveBeenCalledTimes(1)
        const [path, line] = append.mock.calls[0]!
        expect(path).toBe('/tmp/x.log')
        expect(line).toBe('2026-06-13T12:00:00.000Z|info|check: start|{"seq":1}\n')
    })
    it('uses JSON.stringify(null) when data is undefined', () => {
        const append = vi.fn<(...args: unknown[]) => void>()
        const b = createFileBackend({
            path: '/tmp/x.log',
            isEnabled: () => true,
            append,
            nowIso: () => '2026-06-13T12:00:00.000Z',
        })
        b.log('info', 'check', 'empty')
        expect(append.mock.calls[0]![1]).toBe('2026-06-13T12:00:00.000Z|info|check: empty|null\n')
    })
    it('swallows write errors silently', () => {
        const append = vi.fn<() => void>(() => {
            throw new Error('disk full')
        })
        const b = createFileBackend({
            path: '/tmp/x.log',
            isEnabled: () => true,
            append,
            nowIso: () => 'X',
        })
        expect(() => b.log('info', 's', 'm')).not.toThrow()
    })
    it('honors isEnabled', () => {
        const append = vi.fn<(...args: unknown[]) => void>()
        const b = createFileBackend({
            path: '/tmp/x.log',
            isEnabled: () => false,
            append,
            nowIso: () => 'X',
        })
        expect(b.enabled()).toBe(false)
        b.log('info', 's', 'm')
        expect(append).not.toHaveBeenCalled()
    })
})

describe('createLocalStorageOverrideBackend', () => {
    // @vitest-environment jsdom
    it('returns false when localStorage is unset (matches the existing browser default-off contract)', () => {
        const inner = { enabled: () => true, log: vi.fn<(...args: unknown[]) => void>() }
        const b = createLocalStorageOverrideBackend({ storageKey: 'gfDebug', inner })
        expect(b.enabled()).toBe(false)
    })
    it('returns false when localStorage flag is "0" or ""', () => {
        const inner = { enabled: () => true, log: vi.fn<(...args: unknown[]) => void>() }
        const b = createLocalStorageOverrideBackend({ storageKey: 'gfDebug', inner })
        localStorage.setItem('gfDebug', '0')
        expect(b.enabled()).toBe(false)
        localStorage.setItem('gfDebug', '')
        expect(b.enabled()).toBe(false)
    })
    it('returns true when localStorage flag is "1"', () => {
        const inner = { enabled: () => true, log: vi.fn<(...args: unknown[]) => void>() }
        const b = createLocalStorageOverrideBackend({ storageKey: 'gfDebug', inner })
        localStorage.setItem('gfDebug', '1')
        expect(b.enabled()).toBe(true)
    })
    it('forwards log() to the inner backend', () => {
        const inner = { enabled: () => true, log: vi.fn<(...args: unknown[]) => void>() }
        const b = createLocalStorageOverrideBackend({ storageKey: 'gfDebug', inner })
        b.log('info', 's', 'm', { x: 1 })
        expect(inner.log).toHaveBeenCalledWith('info', 's', 'm', { x: 1 })
    })
})
