// Content-script orchestrator. Wires input -> api -> overlay -> signal. Plain
// TS + native DOM in an open shadow root (NO React — MV3 startup budget).
// Fleshed out in WS-B Task 9; the layer modules land in Tasks 1-8.
export default defineContentScript({
    matches: ['<all_urls>'],
    runAt: 'document_idle',
    main() {},
})
