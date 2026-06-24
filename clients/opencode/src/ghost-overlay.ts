// ghost-overlay.ts — Path A self-render ghost overlay (pure logic).
// The JSX render lives in tui-entry.tsx:GhostComponent.
//
// TODO(Path B): swap self-render for promptRef.ghostText — one call-site.
//   Replace deps.ghostRenderer with a thin adapter that calls:
//     api.prompt?.ref()?.ghostText?.set(text, { atOffset })
//   The orchestrator's trigger/accept/cancel logic stays unchanged.

/** Characters that signal a sentence is complete — the user is unlikely
 *  to want a continuation immediately after these. */
const TERMINAL_PUNCTUATION = new Set([".", "?", "!", ":", ";"]);

/**
 * Returns true when the prompt text "looks unfinished" — the user might
 * want a completion. Rules:
 *   1. Non-empty
 *   2. Not pure whitespace
 *   3. At least 3 characters
 *   4. Last non-whitespace character is NOT terminal punctuation
 */
export function lineLooksUnfinished(text: string): boolean {
    if (text.length === 0) return false;
    if (text.trim().length === 0) return false;
    if (text.length < 3) return false;
    const trimmedEnd = text.trimEnd();
    if (trimmedEnd.length === 0) return false;
    const lastChar = trimmedEnd[trimmedEnd.length - 1]!;
    return !TERMINAL_PUNCTUATION.has(lastChar);
}

/**
 * Join a continuation onto the existing prompt text with correct spacing.
 *
 * The bridge's /complete returns a bare continuation with NO leading space, so
 * `"the"` + `"lazy dog."` would render/insert as `"thelazy dog."`. This inserts
 * a single joining space ONLY when both sides are "word-ish" (the text ends in a
 * non-space char AND the continuation starts with a non-space, non-punctuation
 * char). It does NOT add a space when:
 *   - the text already ends with whitespace (user typed a trailing space),
 *   - the continuation already starts with whitespace,
 *   - the continuation starts with punctuation (e.g. ".", ",", "'s", ")") that
 *     should butt directly against the preceding word.
 * Returns the continuation with the leading space prepended when needed, else
 * the continuation unchanged. Pure — no I/O.
 */
const CONTINUATION_NO_SPACE_PREFIX = new Set([
    ".", ",", "!", "?", ":", ";", ")", "]", "}", "'", "\u2019", "\"", "-", "\n",
]);

export function joinContinuation(text: string, continuation: string): string {
    if (continuation.length === 0) return continuation;
    if (text.length === 0) return continuation;
    const lastChar = text[text.length - 1]!;
    const firstChar = continuation[0]!;
    // Text ends in whitespace, or continuation already leads with space → no join.
    if (/\s/.test(lastChar)) return continuation;
    if (/\s/.test(firstChar)) return continuation;
    // Continuation starts with punctuation that hugs the previous word → no space.
    if (CONTINUATION_NO_SPACE_PREFIX.has(firstChar)) return continuation;
    // Both sides word-ish → insert one joining space.
    return " " + continuation;
}

/** Shape the orchestrator receives to push ghost text into the render layer. */
export interface GhostRenderer {
    renderGhost(text: string, atOffset: number): void;
    clearGhost(): void;
}

export interface GhostPayload {
    text: string;
    atOffset: number;
}

// Bridge between the orchestrator's imperative renderGhost/clearGhost calls
// and the JSX GhostComponent's reactive render. Mirrors PanelController:
//   - lastPayload is held so a freshly-mounted GhostComponent INITIALIZES
//     from the current value (the host re-invokes the slot fn on prompt
//     re-renders, remounting GhostComponent with a null-default signal).
//   - a subscriber Set (not a single setter) so EVERY live GhostComponent
//     instance receives updates. The prior single-setter + idempotent-guard
//     design pinned the setter to the FIRST-mounted component; once the host
//     remounted it, pushGhostPayload updated a disposed signal and the ghost
//     never rendered (completion result arrived but no overlay painted).
let lastPayload: GhostPayload | null = null;
const ghostSubscribers = new Set<(v: GhostPayload | null) => void>();

/** The current ghost payload — read by a freshly-mounted GhostComponent to
 *  initialize its local signal (so a slot re-invoke restores the live ghost). */
export function currentGhostPayload(): GhostPayload | null {
    return lastPayload;
}

/**
 * Subscribe a GhostComponent's local signal setter. Returns an unsubscribe
 * fn (call in onCleanup). Multiple live components are supported — each gets
 * every update, so a remount can never strand the orchestrator's setter.
 */
export function subscribeGhost(set: (v: GhostPayload | null) => void): () => void {
    ghostSubscribers.add(set);
    return () => {
        ghostSubscribers.delete(set);
    };
}

/** Imperative push from the orchestrator — called by renderGhost/clearGhost. */
export function pushGhostPayload(payload: GhostPayload | null): void {
    lastPayload = payload;
    // Snapshot before fanout — a setter could synchronously trigger a remount
    // that re-subscribes mid-iteration (see PanelController's setView note).
    for (const set of [...ghostSubscribers]) {
        set(payload);
    }
}
