// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { applyFix, getText } from '@/input/text'

const mkTextarea = (value = ''): HTMLTextAreaElement => {
    const t = document.createElement('textarea')
    t.value = value
    document.body.appendChild(t)
    return t
}

const mkInput = (value = '', type = 'text'): HTMLInputElement => {
    const i = document.createElement('input')
    i.type = type
    i.value = value
    document.body.appendChild(i)
    return i
}

const mkCE = (html: string): HTMLDivElement => {
    const d = document.createElement('div')
    d.setAttribute('contenteditable', 'true')
    d.innerHTML = html
    document.body.appendChild(d)
    return d
}

describe('getText', () => {
    it('reads .value from a <textarea>', () => {
        const t = mkTextarea('hello world')
        expect(getText(t)).toBe('hello world')
    })

    it('reads .value from <input type="text">', () => {
        const i = mkInput('an email', 'email')
        expect(getText(i)).toBe('an email')
    })

    it('reads flattened textContent from a contenteditable', () => {
        const d = mkCE('<p>Hello <b>world</b>!</p>')
        expect(getText(d)).toBe('Hello world!')
    })

    it('returns "" for an empty contenteditable', () => {
        const d = mkCE('')
        expect(getText(d)).toBe('')
    })
})

describe('applyFix — textarea / input (value path, jsdom-testable)', () => {
    it('replaces the span and dispatches an "input" event on a textarea', () => {
        const t = mkTextarea('teh cat')
        const dispatched: Event[] = []
        t.addEventListener('input', (e) => dispatched.push(e))

        applyFix(t, { start: 0, end: 3 }, 'the')

        expect(t.value).toBe('the cat')
        expect(dispatched).toHaveLength(1)
        expect(dispatched[0]!.type).toBe('input')
        expect(dispatched[0]!.bubbles).toBe(true)
    })

    it('replaces the span and dispatches an "input" event on an <input>', () => {
        const i = mkInput('teh cat', 'email')
        const dispatched: Event[] = []
        i.addEventListener('input', (e) => dispatched.push(e))

        applyFix(i, { start: 0, end: 3 }, 'the')

        expect(i.value).toBe('the cat')
        expect(dispatched).toHaveLength(1)
    })

    it('replaces a mid-string span', () => {
        const t = mkTextarea('the teh cat')
        applyFix(t, { start: 4, end: 7 }, 'the')
        expect(t.value).toBe('the the cat')
    })

    it('replaces a zero-width span (pure insertion)', () => {
        const t = mkTextarea('the cat')
        applyFix(t, { start: 4, end: 4 }, 'big ')
        expect(t.value).toBe('the big cat')
    })
})

describe('applyFix — contenteditable (execCommand path)', () => {
    it('selects the span range and calls execCommand("insertText") with the replacement', () => {
        const d = mkCE('the <b>teh</b> cat')
        // Find the text node "teh"
        const textNode = Array.from(d.querySelectorAll('b'))
            .map((b) => b.firstChild)
            .find((n): n is Text => n?.nodeType === Node.TEXT_NODE)
        expect(textNode).toBeDefined()
        if (!textNode) return

        // Pre-clear any selection so we can assert applyFix sets a fresh one.
        const sel = document.getSelection()!
        sel.removeAllRanges()
        expect(sel.rangeCount).toBe(0)

        const execSpy = vi.fn<() => boolean>(() => true)
        // jsdom's document.execCommand is a no-op; spy on it to assert the call.
        const originalExec = document.execCommand
        document.execCommand = execSpy

        try {
            applyFix(d, { start: 4, end: 7 }, 'the')
        } finally {
            document.execCommand = originalExec
        }

        // 1) execCommand was called exactly once with the right command + text.
        expect(execSpy).toHaveBeenCalledTimes(1)
        expect(execSpy).toHaveBeenCalledWith('insertText', false, 'the')

        // 2) applyFix set a fresh selection over the span (not whatever was
        //    selected before). jsdom doesn't mutate text from execCommand, so
        //    we assert the selection state directly. In a real browser the
        //    host editor's replaceSelection runs in this same frame.
        expect(sel.rangeCount).toBe(1)
        const selRange = sel.getRangeAt(0)
        // "the <b>teh</b> cat" flattened is "the teh cat" (12 chars).
        // The span is start=4, end=7 → "teh".
        expect(selRange.toString()).toBe('teh')

        // jsdom limitation: document.execCommand does not mutate text. The
        // production code routes the mutation through the host editor's
        // replaceSelection via execCommand('insertText', ...), which is what
        // preserves the native undo/redo stack. Verified here via the spy +
        // selection state.
    })

    it('handles a multi-text-node span (range walks across element boundaries)', () => {
        // "abc<b>def</b>ghi" → flattened "abcdefghi". Span start=2, end=7 → "c<b>def</b>g" boundary crossing.
        const d = mkCE('abc<b>def</b>ghi')
        const execSpy = vi.fn<() => boolean>(() => true)
        const originalExec = document.execCommand
        document.execCommand = execSpy

        try {
            applyFix(d, { start: 2, end: 7 }, 'X')
        } finally {
            document.execCommand = originalExec
        }

        expect(execSpy).toHaveBeenCalledTimes(1)
        expect(execSpy).toHaveBeenCalledWith('insertText', false, 'X')
        const sel = document.getSelection()!
        expect(sel.rangeCount).toBe(1)
        expect(sel.getRangeAt(0).toString()).toBe('cdefg')
    })

    it('is a no-op (no execCommand) when the span is out of range', () => {
        const d = mkCE('short')
        const execSpy = vi.fn<() => boolean>(() => true)
        const originalExec = document.execCommand
        document.execCommand = execSpy

        try {
            applyFix(d, { start: 99, end: 100 }, 'X')
        } finally {
            document.execCommand = originalExec
        }

        expect(execSpy).not.toHaveBeenCalled()
    })
})
