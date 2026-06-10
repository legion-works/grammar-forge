// MAIN-world apply bridge. The Slate-safe synthetic-replacement apply
// (rich-editor-apply.ts) CANNOT be dispatched from a content script: the
// `getTargetRanges` override exists only on the ISOLATED-world event
// wrapper, so the page's Slate reads the native (empty) target ranges and
// inserts every replacement at its model selection — apply-all garbled
// text on discord.com web (verified live 2026-06-10). The dispatch must
// happen IN THE PAGE WORLD.
//
// Protocol (worlds share the DOM, but NOT JS objects — CustomEvent.detail
// does not cross worlds in Chromium; DOM attributes and event dispatch do):
//   1. isolated: write the JSON payload to a data attribute ON the target
//      element, dispatch REQUEST_EVENT on it.
//   2. main-world agent (document-level capture listener): read+remove the
//      payload attribute, run applySlateFix in the page world, write the
//      JSON result to a second attribute, dispatch RESULT_EVENT on the
//      element.
//   3. isolated: read+remove the result attribute, resolve. A timeout
//      resolves false so missing agents (Firefox — world:MAIN is
//      Chromium-only; or an extension update before page reload) degrade
//      to the caller's legacy path.
//
// The agent is inert until a request event arrives and touches nothing
// else on the page.
import {
    applySlateFix as defaultApplySlateFix,
    type ApplyTraceLogger,
} from '@/input/rich-editor-apply'
import type { CodeUnitSpan } from '@/input/text'

export const APPLY_REQUEST_EVENT = 'grammarforge:apply-request'
export const APPLY_RESULT_EVENT = 'grammarforge:apply-result'
export const APPLY_PAYLOAD_ATTR = 'data-grammarforge-apply'
export const APPLY_RESULT_ATTR = 'data-grammarforge-apply-result'

/** Generous default: the agent's applySlateFix may poll up to 400ms before
 *  reporting, plus a possible legacy-fallback round inside the page world. */
const DEFAULT_TIMEOUT_MS = 2500

interface ApplyRequestPayload {
    id: string
    start: number
    end: number
    replacement: string
}

interface ApplyResultPayload {
    id: string
    ok: boolean
}

/**
 * ISOLATED-world side: ask the main-world agent to apply `replacement` over
 * `span` on `el`. Resolves true when the agent reports success, false on
 * agent failure, malformed reply, or timeout (no agent injected) — callers
 * fall back to the legacy apply path on false.
 */
export function requestMainWorldApply(
    el: HTMLElement,
    span: CodeUnitSpan,
    replacement: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
    return new Promise((resolve) => {
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        const payload: ApplyRequestPayload = { id, start: span.start, end: span.end, replacement }

        let settled = false
        const finish = (ok: boolean): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            el.removeEventListener(APPLY_RESULT_EVENT, onResult)
            el.removeAttribute(APPLY_PAYLOAD_ATTR)
            el.removeAttribute(APPLY_RESULT_ATTR)
            resolve(ok)
        }

        const onResult = (): void => {
            const raw = el.getAttribute(APPLY_RESULT_ATTR)
            if (!raw) return
            let parsed: ApplyResultPayload
            try {
                parsed = JSON.parse(raw) as ApplyResultPayload
            } catch {
                finish(false)
                return
            }
            // A reply for an OLDER request (stale attribute) is ignored —
            // the timeout still guards this request.
            if (parsed.id !== id) return
            finish(parsed.ok === true)
        }

        const timer = setTimeout(() => finish(false), timeoutMs)
        el.addEventListener(APPLY_RESULT_EVENT, onResult)
        el.setAttribute(APPLY_PAYLOAD_ATTR, JSON.stringify(payload))
        el.dispatchEvent(new CustomEvent(APPLY_REQUEST_EVENT, { bubbles: true }))
    })
}

export interface ApplyAgentDeps {
    /** Injectable for tests. Defaults to the real applySlateFix. */
    apply?: (
        el: HTMLElement,
        span: CodeUnitSpan,
        replacement: string,
        log?: ApplyTraceLogger,
    ) => Promise<boolean>
    doc?: Document
}

/**
 * MAIN-world side: install the document-level agent. Idempotent per
 * document (re-injection no-ops). Returns an uninstall function (tests).
 */
export function installMainWorldApplyAgent(deps: ApplyAgentDeps = {}): () => void {
    const doc = deps.doc ?? document
    const apply = deps.apply ?? defaultApplySlateFix
    const FLAG = '__grammarforgeApplyAgent'
    const holder = doc as Document & { [key: string]: unknown }
    if (holder[FLAG]) return () => {}
    holder[FLAG] = true

    const onRequest = (e: Event): void => {
        const el = e.target
        if (!(el instanceof HTMLElement)) return
        const raw = el.getAttribute(APPLY_PAYLOAD_ATTR)
        if (!raw) return
        el.removeAttribute(APPLY_PAYLOAD_ATTR)
        let payload: ApplyRequestPayload
        try {
            payload = JSON.parse(raw) as ApplyRequestPayload
        } catch {
            return
        }
        void apply(el, { start: payload.start, end: payload.end }, payload.replacement)
            .catch(() => false)
            .then((ok) => {
                const result: ApplyResultPayload = { id: payload.id, ok: ok === true }
                el.setAttribute(APPLY_RESULT_ATTR, JSON.stringify(result))
                el.dispatchEvent(new CustomEvent(APPLY_RESULT_EVENT, { bubbles: false }))
            })
    }

    doc.addEventListener(APPLY_REQUEST_EVENT, onRequest, { capture: true })
    return () => {
        doc.removeEventListener(APPLY_REQUEST_EVENT, onRequest, { capture: true })
        delete holder[FLAG]
    }
}
