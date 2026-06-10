// MAIN-world apply agent (Chromium-only — world MAIN is unsupported
// elsewhere; non-Chromium browsers simply never inject this, and the
// isolated side's request timeout degrades to the legacy apply path).
// The agent is a single inert document-level listener: it does nothing
// until a GrammarForge apply-request event arrives, then performs the
// Slate-safe synthetic-replacement apply IN THE PAGE WORLD, where the
// getTargetRanges override is visible to the page's editor framework.
// See src/input/main-world-apply.ts for the cross-world protocol.
import { installMainWorldApplyAgent } from '@/input/main-world-apply'

export default defineContentScript({
    matches: ['<all_urls>'],
    world: 'MAIN',
    runAt: 'document_idle',
    main() {
        installMainWorldApplyAgent()
    },
})
