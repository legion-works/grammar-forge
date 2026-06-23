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

/** Shape the orchestrator receives to push ghost text into the render layer. */
export interface GhostRenderer {
    renderGhost(text: string, atOffset: number): void;
    clearGhost(): void;
}

export interface GhostPayload {
    text: string;
    atOffset: number;
}

// SolidJS signal holder — populated by tui-entry.tsx:GhostComponent.
// The signal is the bridge between the orchestrator's imperative calls
// and the JSX component's reactive render. Same pattern as PanelController.
// Using `any` types to avoid importing solid-js in this pure-logic module;
// the actual signal types are resolved in tui-entry.tsx.
let ghostSignalGet: (() => GhostPayload | null) | null = null;
let ghostSignalSet: ((v: GhostPayload | null) => void) | null = null;

/** Called once by tui-entry.tsx to wire the solid signal. */
export function initGhostSignal(
    get: () => GhostPayload | null,
    set: (v: GhostPayload | null) => void,
): void {
    ghostSignalGet = get;
    ghostSignalSet = set;
}

/** Imperative push from the orchestrator — called by renderGhost. */
export function pushGhostPayload(payload: GhostPayload | null): void {
    ghostSignalSet?.(payload);
}

/** Get the current ghost payload (for the GhostComponent reactive read). */
export function getGhostPayload(): GhostPayload | null {
    return ghostSignalGet?.() ?? null;
}
