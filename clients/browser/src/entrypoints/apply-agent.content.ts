// MAIN-world apply agent (Chromium-only — world MAIN is unsupported
// elsewhere; non-Chromium browsers simply never inject this, and the
// isolated side's request timeout degrades to the legacy apply path).
// The agent is a single inert document-level listener: it does nothing
// until a GrammarForge apply-request event arrives, then performs the
// Slate-safe synthetic-replacement apply IN THE PAGE WORLD, where the
// getTargetRanges override is visible to the page's editor framework.
// See src/input/main-world-apply.ts for the cross-world protocol.
import { installMainWorldApplyAgent } from '@/input/main-world-apply'
import { debugLog } from '@/lib/debug-log'

export default defineContentScript({
    matches: ['<all_urls>'],
    world: 'MAIN',
    runAt: 'document_idle',
    main() {
        // MAIN-world scripts share the page's global namespace with
        // whatever the host page itself runs — a hostile or merely buggy
        // page (a frozen/patched Object.prototype, a poisoned
        // addEventListener, etc.) could make installMainWorldApplyAgent()
        // throw. An uncaught throw here would kill this content script
        // silently (no console output the user would ever see); the
        // isolated-world side already degrades gracefully to the legacy
        // apply path when the MAIN-world agent never responds (see
        // main-world-apply.ts's request timeout), so the only thing this
        // guards against is a SILENT failure — hence a debug-level log
        // rather than surfacing anything to the end user.
        try {
            installMainWorldApplyAgent()
        } catch (e) {
            debugLog('apply-agent', 'installMainWorldApplyAgent threw; MAIN-world apply unavailable', e)
        }
    },
})
