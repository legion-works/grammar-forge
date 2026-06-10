import { describe, expect, it } from 'vitest'
import { isLocalBridgeUrl } from '@/api/url'

describe('isLocalBridgeUrl', () => {
    it.each([
        ['http://localhost:8000', true],
        ['http://127.0.0.1:8000', true],
        ['http://[::1]:8000', true],
        ['http://192.168.1.5:8000', true],
        ['http://10.0.0.3:8000', true],
        ['http://example.com:8000', false],
        ['https://api.openai.com', false],
        // spoofing regression: prefix-regex bypass
        ['http://127.0.0.1.evil.com', false],
        ['http://10.0.0.1.example.com', false],
        // RFC-1918 boundary cases
        ['http://172.15.0.1', false],
        ['http://172.32.0.1', false],
        ['http://172.16.0.1', true],
        ['http://192.168.1.1', true],
        ['http://[::1]:8000', true],
        // invalid octet
        ['http://999.0.0.1', false],
    ])('isLocalBridgeUrl(%s) === %s', (url, want) => {
        expect(isLocalBridgeUrl(url as string)).toBe(want)
    })

    it('rejects non-http(s) schemes even with local hosts', () => {
        expect(isLocalBridgeUrl('javascript:alert(1)')).toBe(false)
        expect(isLocalBridgeUrl('file:///etc/passwd')).toBe(false)
        expect(isLocalBridgeUrl('ftp://127.0.0.1/x')).toBe(false)
        expect(isLocalBridgeUrl('data:text/html,x')).toBe(false)
        expect(isLocalBridgeUrl('ws://127.0.0.1:8000')).toBe(false)
    })
})
