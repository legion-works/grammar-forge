// Slate-aware replacement for the browser client's synchronous applyFix on
// Discord's composer.
//
// WHY (root-caused live in Vesktop, 2026-06-10): any EXTERNAL mutation of the
// DOM selection around Discord's Slate editor can jam Slate's internal
// selection bookkeeping — its model selection diverges from the DOM and is
// re-asserted over every subsequent click (caret "jumps back"; in the worst
// case a stale full-text selection sticks).
//
// Mechanism: a synthetic `beforeinput` with
// `inputType: "insertReplacementText"` and `getTargetRanges()` overridden to
// the target StaticRange — the native autocorrect protocol. slate-react
// consumes the target range and applies the replacement through its own
// model with NO DOM-selection involvement (verified live in Vesktop).
//
// The editor may apply the change ASYNCHRONOUSLY (React commit), so success
// detection POLLS the text. The legacy selection+execCommand fallback only
// runs after the poll window expires with no text change at all — firing it
// early double-applies the edit AND re-introduces the selection-jam (the
// v2 bug observed live).
import { codeUnitSpanToRange, getText, type CodeUnitSpan } from '@/input/text'

/** Logger injected by the orchestrator (its debugLog). No-op default. */
export type ApplyTraceLogger = (...args: unknown[]) => void

const APPLY_POLL_STEP_MS = 25
const APPLY_POLL_TIMEOUT_MS = 400

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until getText(el) differs from `before` or the window expires.
 *  Returns the final text. */
async function pollForTextChange(el: HTMLElement, before: string): Promise<string> {
    const deadline = Date.now() + APPLY_POLL_TIMEOUT_MS
    for (;;) {
        const now = getText(el)
        if (now !== before) return now
        if (Date.now() >= deadline) return now
        await wait(APPLY_POLL_STEP_MS)
    }
}

/** Compact node descriptor for trace logs. */
function describeNode(n: Node): string {
    if (n.nodeType === Node.TEXT_NODE) {
        return `text"${(n.textContent ?? '').slice(0, 20)}"`
    }
    const el = n as HTMLElement
    return `${el.tagName?.toLowerCase() ?? n.nodeName}.${String(el.className ?? '').slice(0, 30)}`
}

/**
 * Apply `replacement` over `span` (flat code-unit offsets, the same model
 * getText uses) in a rich-text contenteditable. Returns false when the span
 * cannot be resolved (stale text) — callers re-check instead of applying.
 * Every decision point is traced through `log` for live debugging.
 */
export async function applySlateFix(
    el: HTMLElement,
    span: CodeUnitSpan,
    replacement: string,
    log: ApplyTraceLogger = () => {},
): Promise<boolean> {
    const before = getText(el)
    const expected = before.slice(0, span.start) + replacement + before.slice(span.end)
    log('apply: start', {
        span: `[${span.start},${span.end})`,
        spanText: JSON.stringify(before.slice(span.start, span.end)),
        replacement: JSON.stringify(replacement),
        textLen: before.length,
    })
    const range = codeUnitSpanToRange(el, span)
    if (!range) {
        log('apply: FAIL span->range unresolvable')
        return false
    }
    log('apply: range', {
        start: `${describeNode(range.startContainer)}@${range.startOffset}`,
        end: `${describeNode(range.endContainer)}@${range.endOffset}`,
    })

    const staticRange = new StaticRange({
        startContainer: range.startContainer,
        startOffset: range.startOffset,
        endContainer: range.endContainer,
        endOffset: range.endOffset,
    })
    const event = new InputEvent('beforeinput', {
        inputType: 'insertReplacementText',
        data: replacement,
        bubbles: true,
        cancelable: true,
    })
    // Synthetic InputEvents report no target ranges; the editor's beforeinput
    // handler reads them via this method, so supply our range there.
    Object.defineProperty(event, 'getTargetRanges', { value: () => [staticRange] })
    const dispatched = el.dispatchEvent(event)
    log('apply: dispatched insertReplacementText', {
        defaultPrevented: event.defaultPrevented,
        returned: dispatched,
    })

    const after = await pollForTextChange(el, before)
    if (after === expected) {
        log('apply: OK exact match after poll')
        return true
    }
    if (after !== before) {
        log('apply: OK-ish text changed but != expected', {
            after: JSON.stringify(after.slice(0, 60)),
            expected: JSON.stringify(expected.slice(0, 60)),
        })
        return true
    }

    // Poll window expired with NO change: the editor ignored the synthetic
    // replacement (seen with empty-data pure deletions in some editors).
    // Legacy path: focus first (Slate ignores selection changes while
    // unfocused), select, settle one macrotask, then insertText. This path
    // mutates the DOM selection and is the known caret-jam risk — hence
    // last resort only, and loudly traced.
    log('apply: FALLBACK legacy selection+execCommand (synthetic ignored)')
    const sel = el.ownerDocument.getSelection()
    if (!sel) {
        log('apply: FAIL no selection object')
        return false
    }
    el.focus()
    sel.removeAllRanges()
    sel.addRange(range)
    await wait(0)
    const ok = el.ownerDocument.execCommand('insertText', false, replacement)
    const final = await pollForTextChange(el, before)
    log('apply: fallback result', {
        execCommandReturned: ok,
        changed: final !== before,
        matchesExpected: final === expected,
    })
    return true
}
