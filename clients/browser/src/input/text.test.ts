// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { applyFix, codeUnitSpanToRange, domPointToFlatOffset, getText } from '@/input/text'

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

describe('getText — line-aware contenteditable model (virtual newlines)', () => {
    it('separates block-per-line divs with \\n (the joined-lines bug)', () => {
        const d = mkCE('<div>Glorp Zix</div><div>Vrak</div>')
        expect(getText(d)).toBe('Glorp Zix\nVrak')
    })

    it('maps <br> to \\n', () => {
        const d = mkCE('a<br>b')
        expect(getText(d)).toBe('a\nb')
    })

    it('represents an empty middle line (<div><br></div>) as a blank line', () => {
        const d = mkCE('<div>a</div><div><br></div><div>b</div>')
        expect(getText(d)).toBe('a\n\nb')
    })

    it('inline children inside blocks do not add separators', () => {
        const d = mkCE('<p><span>a</span><b>b</b></p><p>c</p>')
        expect(getText(d)).toBe('ab\nc')
    })

    it('a single block has no trailing newline', () => {
        const d = mkCE('<div>a</div>')
        expect(getText(d)).toBe('a')
    })

    it('a bare text node is unchanged', () => {
        const d = mkCE('plain')
        expect(getText(d)).toBe('plain')
    })
})

describe('codeUnitSpanToRange — flat offsets across virtual newlines', () => {
    /** <div>Glorp Zix</div><div>Vrak</div> → flat "Glorp Zix\nVrak";
     *  node1 = "Glorp Zix" (flat 0..9), virtual \n at 9, node2 = "Vrak" (10..14). */
    const mkTwoLines = (): { d: HTMLDivElement; node1: Text; node2: Text } => {
        const d = mkCE('<div>Glorp Zix</div><div>Vrak</div>')
        const divs = d.querySelectorAll('div')
        return {
            d,
            node1: divs[0]!.firstChild as Text,
            node2: divs[1]!.firstChild as Text,
        }
    }

    it('a span fully on line 2 lands in line-2\u2019s text node with shifted offsets', () => {
        const { d, node2 } = mkTwoLines()
        // flat {10,14} is exactly "Vrak"
        const r = codeUnitSpanToRange(d, { start: 10, end: 14 })
        expect(r).not.toBeNull()
        expect(r!.startContainer).toBe(node2)
        expect(r!.startOffset).toBe(0)
        expect(r!.endContainer).toBe(node2)
        expect(r!.endOffset).toBe(4)
        expect(r!.toString()).toBe('Vrak')
    })

    it('a span ending at end-of-line-1 stays inside line 1\u2019s text node', () => {
        const { d, node1 } = mkTwoLines()
        const r = codeUnitSpanToRange(d, { start: 0, end: 9 })
        expect(r).not.toBeNull()
        expect(r!.endContainer).toBe(node1)
        expect(r!.endOffset).toBe(9)
        expect(r!.toString()).toBe('Glorp Zix')
    })

    it('a span crossing the virtual newline yields a cross-block Range', () => {
        const { d, node1, node2 } = mkTwoLines()
        // flat {6,12} = "Zix\nVr"
        const r = codeUnitSpanToRange(d, { start: 6, end: 12 })
        expect(r).not.toBeNull()
        expect(r!.startContainer).toBe(node1)
        expect(r!.startOffset).toBe(6)
        expect(r!.endContainer).toBe(node2)
        expect(r!.endOffset).toBe(2)
    })

    it('a span covering only the virtual newline brackets the line boundary', () => {
        const { d, node1, node2 } = mkTwoLines()
        const r = codeUnitSpanToRange(d, { start: 9, end: 10 })
        expect(r).not.toBeNull()
        expect(r!.startContainer).toBe(node1)
        expect(r!.startOffset).toBe(9)
        expect(r!.endContainer).toBe(node2)
        expect(r!.endOffset).toBe(0)
    })

    it('returns null when the span exceeds the flat length', () => {
        const { d } = mkTwoLines()
        expect(codeUnitSpanToRange(d, { start: 0, end: 99 })).toBeNull()
        expect(codeUnitSpanToRange(d, { start: 99, end: 100 })).toBeNull()
    })
})

describe('domPointToFlatOffset (selection endpoint → flat offset)', () => {
    it('maps text-node points through the virtual newline shift', () => {
        const d = mkCE('<div>Glorp Zix</div><div>Vrak</div>')
        const divs = d.querySelectorAll('div')
        const node1 = divs[0]!.firstChild as Text
        const node2 = divs[1]!.firstChild as Text
        expect(domPointToFlatOffset(d, node1, 5)).toBe(5)
        expect(domPointToFlatOffset(d, node2, 0)).toBe(10)
        expect(domPointToFlatOffset(d, node2, 4)).toBe(14)
    })

    it('maps element-boundary points to the next content / total length', () => {
        const d = mkCE('<div>Glorp Zix</div><div>Vrak</div>')
        // boundary before the second div → start of "Vrak" in the flat model
        expect(domPointToFlatOffset(d, d, 1)).toBe(10)
        // end of the host element → the flat length
        expect(domPointToFlatOffset(d, d, 2)).toBe(14)
    })

    it('returns null for a node outside the element', () => {
        const d = mkCE('<div>a</div>')
        const stray = document.createElement('div')
        stray.textContent = 'x'
        document.body.appendChild(stray)
        expect(domPointToFlatOffset(d, stray.firstChild as Text, 0)).toBeNull()
        stray.remove()
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
