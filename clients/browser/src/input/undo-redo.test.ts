import { describe, expect, it } from 'vitest'
import { isRedoKeydown, isUndoKeydown, isUndoRedoKeydown, type KeyChord } from '@/input/undo-redo'

function chord(overrides: Partial<KeyChord>): KeyChord {
    return { key: 'z', ctrlKey: false, metaKey: false, shiftKey: false, ...overrides }
}

describe('isUndoKeydown', () => {
    it('matches Ctrl+Z and Cmd+Z', () => {
        expect(isUndoKeydown(chord({ key: 'z', ctrlKey: true }))).toBe(true)
        expect(isUndoKeydown(chord({ key: 'z', metaKey: true }))).toBe(true)
        // uppercase key (some layouts report 'Z')
        expect(isUndoKeydown(chord({ key: 'Z', ctrlKey: true }))).toBe(true)
    })

    it('is false without a modifier', () => {
        expect(isUndoKeydown(chord({ key: 'z' }))).toBe(false)
    })

    it('is false for Ctrl+Shift+Z (that is redo, not undo)', () => {
        expect(isUndoKeydown(chord({ key: 'z', ctrlKey: true, shiftKey: true }))).toBe(false)
    })
})

describe('isRedoKeydown', () => {
    it('matches Ctrl+Y / Cmd+Y', () => {
        expect(isRedoKeydown(chord({ key: 'y', ctrlKey: true }))).toBe(true)
        expect(isRedoKeydown(chord({ key: 'Y', metaKey: true }))).toBe(true)
    })

    it('matches Ctrl+Shift+Z / Cmd+Shift+Z', () => {
        expect(isRedoKeydown(chord({ key: 'z', ctrlKey: true, shiftKey: true }))).toBe(true)
        expect(isRedoKeydown(chord({ key: 'Z', metaKey: true, shiftKey: true }))).toBe(true)
    })

    it('is false for plain Ctrl+Z (undo) and unmodified keys', () => {
        expect(isRedoKeydown(chord({ key: 'z', ctrlKey: true }))).toBe(false)
        expect(isRedoKeydown(chord({ key: 'y' }))).toBe(false)
    })
})

describe('isUndoRedoKeydown', () => {
    it('is true for undo and redo chords', () => {
        expect(isUndoRedoKeydown(chord({ key: 'z', ctrlKey: true }))).toBe(true)
        expect(isUndoRedoKeydown(chord({ key: 'y', ctrlKey: true }))).toBe(true)
        expect(isUndoRedoKeydown(chord({ key: 'z', ctrlKey: true, shiftKey: true }))).toBe(true)
    })

    it('is false for ordinary typing chords', () => {
        expect(isUndoRedoKeydown(chord({ key: 'a', ctrlKey: true }))).toBe(false)
        expect(isUndoRedoKeydown(chord({ key: 'z' }))).toBe(false)
        // Ctrl+. is the accept hotkey, not undo/redo
        expect(isUndoRedoKeydown(chord({ key: '.', ctrlKey: true }))).toBe(false)
    })
})
