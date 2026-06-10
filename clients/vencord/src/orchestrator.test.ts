import { describe, expect, it } from 'vitest'
import { inputGate, resolveSelectionSpan } from './orchestrator'

describe('inputGate', () => {
    it('schedules a check for plain typing', () => {
        expect(inputGate('insertText', { checkPastedText: false })).toBe('check')
    })
    it('skips pastes when checkPastedText is off', () => {
        expect(inputGate('insertFromPaste', { checkPastedText: false })).toBe('skip')
    })
    it('defers pastes to the grace window when checkPastedText is on', () => {
        expect(inputGate('insertFromPaste', { checkPastedText: true })).toBe('grace')
    })
    it('treats unknown/empty inputType as typing', () => {
        expect(inputGate('', { checkPastedText: false })).toBe('check')
    })
})

describe('resolveSelectionSpan', () => {
    it('returns the endpoints verbatim when both resolve and are ordered', () => {
        expect(resolveSelectionSpan(5, 10)).toEqual({ start: 5, end: 10 })
    })
    it('returns {0,0} when the start endpoint is unresolvable', () => {
        expect(resolveSelectionSpan(null, 10)).toEqual({ start: 0, end: 0 })
    })
    it('returns {0,0} when the end endpoint is unresolvable', () => {
        expect(resolveSelectionSpan(5, null)).toEqual({ start: 0, end: 0 })
    })
    it('returns {0,0} when both endpoints are unresolvable', () => {
        expect(resolveSelectionSpan(null, null)).toEqual({ start: 0, end: 0 })
    })
    it('returns {0,0} when the endpoints are inverted (end < start)', () => {
        expect(resolveSelectionSpan(10, 5)).toEqual({ start: 0, end: 0 })
    })
    it('keeps a collapsed selection (end === start) as-is for the caller to discard', () => {
        expect(resolveSelectionSpan(5, 5)).toEqual({ start: 5, end: 5 })
    })
})
