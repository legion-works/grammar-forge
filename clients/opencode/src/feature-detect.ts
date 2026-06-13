// Feature-detect helper extracted from startOrchestrator so it can
// be unit-tested headlessly under vitest. The orchestrator used to
// inline these checks; extracting them here gives us:
//   (1) a single source of truth for the gate,
//   (2) pure-function shape: given an api, return the support bits
//       so the test can assert against mock apis (present / absent
//       / partial — one each, as the brief requested).
//
// GATE DEFINITION (post-fix): supported is hasPrompt && hasCursorChange.
// The cursorOffset check is DIAGNOSTIC only — it is read at startup
// where prompt.ref() may return null (the prompt is not mounted
// yet — the home prompt slot renders ~14ms AFTER tui() entered).
// A present onCursorChange function guarantees the capability was
// added to the facade; the live cursorOffset is read at event
// time inside the orchestrator's onCursorMove handler where ref()
// is guaranteed mounted. The handler ALREADY guards non-number
// cursorOffset with an early-exit + diagnostic log, so a theoretical
// facade that has onCursorChange-but-no-cursorOffset would degrade
// gracefully (every event logs "cursorOffset not a number" and is
// skipped) — never crashes, never silently wrong.
//
// Before the fix: hasCursorOffset was load-bearing on the gate. The
// startup probe of prompt.ref() returned null on a fresh boot
// (no prompt mounted yet) → hasCursorOffset: false → supported:
// false → entire pin wiring skipped at startup. onChange/underlines
// survived because they're context-level subscriptions that don't
// need a live ref. The fix: gate on the FUNCTION PRESENCE
// (hasCursorChange) only; the live value is checked at event time.

export interface PromptPinSupport {
    /** api.prompt is present (a non-null/undefined value). */
    hasPrompt: boolean;
    /** api.prompt.onCursorChange is a function. The load-bearing
     *  gate bit — onCursorChange and cursorOffset were added to the
     *  facade in the same commit (coupled). Function presence proves
     *  the capability; live cursorOffset is read at event time. */
    hasCursorChange: boolean;
    /** api.prompt.ref() returns a value whose cursorOffset is a
     *  number. DIAGNOSTIC ONLY — startup-timing-dependent (false
     *  when no prompt is mounted yet, which is the case at the
     *  instant this helper runs). Not part of the gate. */
    hasCursorOffset: boolean;
    /** Composite: hasPrompt && hasCursorChange. The orchestrator
     *  treats a false supported as a no-op for the pin wiring. */
    supported: boolean;
}

export function detectPromptPinSupport(api: unknown): PromptPinSupport {
    const hasPrompt =
        typeof (api as { prompt?: unknown })?.prompt !== "undefined" &&
        (api as { prompt?: unknown })?.prompt !== null;
    const prompt = (api as { prompt?: { onCursorChange?: unknown; ref?: () => unknown } })?.prompt;
    const hasCursorChange = typeof prompt?.onCursorChange === "function";
    // Diagnostic only. ref() may legitimately return null at the
    // startup instant this helper runs (the prompt isn't mounted
    // yet). A null ref is NOT a missing-capability signal — it's a
    // startup-timing artifact. We swallow the result and only log
    // a `true` for "yes, the live ref reports a numeric cursorOffset
    // right now" — useful for the startup log; never used to gate.
    let hasCursorOffset = false;
    if (typeof prompt?.ref === "function") {
        try {
            const ref = prompt.ref();
            const offset = (ref as { cursorOffset?: unknown })?.cursorOffset;
            hasCursorOffset = typeof offset === "number" && Number.isFinite(offset);
        } catch {
            hasCursorOffset = false;
        }
    }
    return {
        hasPrompt,
        hasCursorChange,
        hasCursorOffset,
        // GATE: hasPrompt && hasCursorChange. hasCursorOffset is
        // intentionally excluded — see the file header.
        supported: hasPrompt && hasCursorChange,
    };
}
