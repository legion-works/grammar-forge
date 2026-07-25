// Unit tests for the message schema: type discrimination + sender helpers.

import { describe, expect, it } from 'vitest'
import { isMessage, isTrustedSender, messageSender } from '@/messaging/schema'

describe('messageSender', () => {
    it('builds a TRIGGER_CHECK with no extra fields', () => {
        const send = messageSender('TRIGGER_CHECK')
        const m = send()
        expect(m).toEqual({ type: 'TRIGGER_CHECK' })
    })

    it('passes through additional fields for TAB_STATUS', () => {
        const send = messageSender('TAB_STATUS')
        const m = send({
            enabled: true,
            fieldCount: 3,
            hostname: 'example.com',
            counts: { spelling: 2, grammar: 1 },
        })
        expect(m).toEqual({
            type: 'TAB_STATUS',
            enabled: true,
            fieldCount: 3,
            hostname: 'example.com',
            counts: { spelling: 2, grammar: 1 },
        })
    })

    it('accepts a partial TAB_STATUS payload (omitted fields become undefined)', () => {
        const send = messageSender('TAB_STATUS')
        const m = send({ enabled: false, fieldCount: 0, hostname: 'example.com', counts: {} })
        expect(m.type).toBe('TAB_STATUS')
        expect(m.enabled).toBe(false)
    })
})

describe('isMessage', () => {
    it('narrows on a matching type', () => {
        const m: unknown = { type: 'TRIGGER_CHECK' }
        expect(isMessage(m, 'TRIGGER_CHECK')).toBe(true)
    })

    it('rejects a non-matching type', () => {
        const m: unknown = { type: 'GET_TAB_STATUS' }
        expect(isMessage(m, 'TRIGGER_CHECK')).toBe(false)
    })

    it('rejects non-objects and null', () => {
        expect(isMessage(null, 'TRIGGER_CHECK')).toBe(false)
        expect(isMessage('TRIGGER_CHECK', 'TRIGGER_CHECK')).toBe(false)
        expect(isMessage(42, 'TRIGGER_CHECK')).toBe(false)
    })

    it('rejects a payload that omits the type field', () => {
        expect(isMessage({}, 'TRIGGER_CHECK')).toBe(false)
    })
})

describe('isTrustedSender (P1-8: message-passing hardening)', () => {
    const OWN_ID = 'abcdefghijklmnopqrstuvwxyzabcdef'
    const OWN_ORIGIN = `chrome-extension://${OWN_ID}/`

    it('accepts this extension content script using its tab context', () => {
        expect(isTrustedSender({ id: OWN_ID, tab: { id: 7 } }, OWN_ID, OWN_ORIGIN)).toBe(true)
    })

    it('accepts this extension page using its extension URL', () => {
        expect(
            isTrustedSender(
                { id: OWN_ID, url: `${OWN_ORIGIN}popup.html` },
                OWN_ID,
                OWN_ORIGIN,
            ),
        ).toBe(true)
    })

    it('rejects a sender from a different extension id', () => {
        expect(
            isTrustedSender(
                { id: 'some-other-extension-id', tab: { id: 7 } },
                OWN_ID,
                OWN_ORIGIN,
            ),
        ).toBe(false)
    })

    it('rejects a sender with no id at all (e.g. a web page)', () => {
        expect(isTrustedSender({}, OWN_ID, OWN_ORIGIN)).toBe(false)
    })

    it('rejects a matching id without a content-script or extension-page context', () => {
        expect(isTrustedSender({ id: OWN_ID }, OWN_ID, OWN_ORIGIN)).toBe(false)
        expect(
            isTrustedSender(
                { id: OWN_ID, url: 'https://attacker.example/' },
                OWN_ID,
                OWN_ORIGIN,
            ),
        ).toBe(false)
    })

    it('rejects a null/undefined sender', () => {
        expect(isTrustedSender(null, OWN_ID, OWN_ORIGIN)).toBe(false)
        expect(isTrustedSender(undefined, OWN_ID, OWN_ORIGIN)).toBe(false)
    })
})
