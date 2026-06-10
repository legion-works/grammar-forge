// Slate-safe replacement for the browser client's synchronous applyFix on
// framework rich-text editors (Slate / Lexical).
//
// WHY (root-caused live in Vesktop, 2026-06-10): any EXTERNAL mutation of the
// DOM selection around a Slate editor can jam Slate's internal selection
// bookkeeping — its model selection diverges from the DOM and is re-asserted
// over every subsequent click (caret "jumps back"; in the worst case a stale
// full-text selection sticks).
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

/** Widen a PURE INSERTION onto an adjacent code point. Slate ignores
 *  COLLAPSED target ranges on insertReplacementText and inserts at its own
 *  (possibly stale) model selection instead — verified live: an insertion
 *  targeted at [15,15) landed at the stale selection [13,13). Replacing
 *  "e" with "e." is byte-identical in effect and gives Slate a real range
 *  to replace. Surrogate-pair safe. Prefers widening LEFT; at offset 0
 *  widens RIGHT. The same widening the bridge's LT-compat layer applies to
 *  /v2/check offsets. */
export function widenInsertion(
    before: string,
    span: CodeUnitSpan,
    replacement: string,
): { span: CodeUnitSpan; replacement: string } {
    if (span.start !== span.end || before.length === 0) return { span, replacement }
    if (span.start > 0) {
        let start = span.start - 1
        const prev = before.charCodeAt(start)
        // Low surrogate: include the full pair so the range stays on a
        // code-point boundary.
        if (prev >= 0xdc00 && prev <= 0xdfff && start > 0) start -= 1
        return {
            span: { start, end: span.end },
            replacement: before.slice(start, span.end) + replacement,
        }
    }
    let end = span.end + 1
    const next = before.charCodeAt(span.end)
    // High surrogate: include the full pair.
    if (next >= 0xd800 && next <= 0xdbff && end < before.length) end += 1
    return {
        span: { start: span.start, end },
        replacement: replacement + before.slice(span.end, end),
    }
}

/** True when `el` is (or wraps/sits inside) a framework rich-text editor
 *  that consumes beforeinput through its own model — Slate or Lexical.
 *  These are the editors where the synthetic-replacement protocol is BOTH
 *  required (DOM-selection mutation jams Slate's bookkeeping) and honored.
 *  Plain contenteditables get the legacy path directly: synthetic events
 *  trigger no default action there, and waiting out the 400ms poll per
 *  apply would be a UX regression for no benefit. */
export function isFrameworkRichEditor(el: HTMLElement): boolean {
    const attrs = ['data-slate-editor', 'data-lexical-editor']
    for (const attr of attrs) {
        if (el.hasAttribute(attr)) return true
        if (el.closest(`[${attr}]`)) return true
        if (el.querySelector(`[${attr}]`)) return true
    }
    return false
}

/** Apply `replacement` over `span` (flat code-unit offsets, the same model
 *  getText uses) in a framework rich-text editor. Returns false when the
 *  span cannot be resolved (stale text) — callers re-check instead of
 *  applying. Every decision point is traced through `log` for live
 *  debugging. */
export async function applySlateFix(
    el: HTMLElement,
    rawSpan: CodeUnitSpan,
    rawReplacement: string,
    log: ApplyTraceLogger = () => {},
): Promise<boolean> {
    const before = getText(el)
    const expected = before.slice(0, rawSpan.start) + rawReplacement + before.slice(rawSpan.end)
    const { span, replacement } = widenInsertion(before, rawSpan, rawReplacement)
    log('apply: start', {
        span: `[${span.start},${span.end})`,
        spanText: JSON.stringify(before.slice(span.start, span.end)),
        replacement: JSON.stringify(replacement),
        widened: span.start !== rawSpan.start || span.end !== rawSpan.end,
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
