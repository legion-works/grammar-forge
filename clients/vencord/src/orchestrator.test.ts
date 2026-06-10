import { describe, expect, it } from 'vitest'
import { inputGate } from './orchestrator'

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
