// Pin-details panel controller. PURE — no opentui imports, no FFI.
//
// The controller holds the current pin/unpin payload (setView) and
// fans out to any subscribed listeners. The signal/effect ownership
// is in tui-entry.tsx's PanelComponent, NOT here — the d5dfa63 live
// run proved that ONLY a signal created inside the component the
// HOST MOUNTS rides the host's scheduler. Our BUNDLED solid
// instance has its own scheduler the host never pumps; external
// createSignal/createEffect created at tui()-time or in a detached
// createRoot queue updates that never flush. The controller stays
// pure here; PanelComponent creates its OWN createSignal at mount
// and subscribes to the controller's setView fanout.
//
// This module is vitest-testable headlessly (no FFI) AND tsc-checked
// (no @opentui imports). The subscribe/setView fanout is the
// load-bearing piece — PanelComponent calls subscribe(localSetView)
// at mount + onCleanup(unsub) to wire its in-component signal to
// the orchestrator's pin/unpin pushes.

export interface PanelItemInput {
    category: string;
    original: string;
    replacement: string;
    isDeletion?: boolean;
}

export type PanelView = SuggestionPanelView | RephraseLoadingView | RephraseResultView;

export interface SuggestionPanelView {
    kind: "suggestion";
    item: PanelItemInput;
    index: number;
    total: number;
    /** Display-width offset of the pinned word's START in the prompt
     *  buffer. Used by the overlay card to call offsetToScreen and
     *  anchor the popup above the word. */
    displayStart: number;
    /** Resolved cycleNext hotkey (settings.cycleNextHotkey). Threaded
     *  in so the card's hint line can reflect the actual bound key
     *  — never drift from the keymap. */
    cycleNextKey: string;
    /** Resolved cyclePrev hotkey (settings.cyclePrevHotkey). Threaded
     *  in so the card's hint line can reflect the actual bound key
     *  — never drift from the keymap. */
    cyclePrevKey: string;
}

export interface RephraseLoadingView {
    kind: "rephrase-loading";
    /** Spinner frame index — incremented by the orchestrator's setInterval
     *  timer and pushed via controller.setView so the host's scheduler
     *  drives the animation (NOT an in-component setInterval). */
    frame: number;
    displayStart: number;
}

export interface RephraseResultView {
    kind: "rephrase-result";
    original: string;
    rephrased: string;
    alternatives: string[];   // NEW: all variants
    altIndex: number;         // NEW: which alternative is shown
    altTotal: number;         // NEW: total variants (1 + alternatives.length)
    scrollOffset: number;     // NEW: line scroll (A4)
    displayStart: number;
}

export interface PanelController {
    /** Push a transition (pin / unpin). All subscribers (e.g. the
     *  PanelComponent's local createSignal setter) are notified
     *  synchronously. */
    setView: (next: PanelView | null) => void;
    /** Subscribe to setView notifications. Returns an unsubscribe
     *  function. The callback receives the same payload that
     *  setView was called with (or null for unpin). Multiple
     *  subscribers are supported (e.g. for tests + the component). */
    subscribe: (cb: (next: PanelView | null) => void) => () => void;
    /** The last value passed to setView (or null). A freshly-mounted
     *  PanelComponent reads this to INITIALIZE its local signal, so a
     *  slot re-invoke that re-mounts the component restores the current
     *  card instead of resetting to null. The host re-invokes the slot
     *  fn (re-mounting PanelComponent) on prompt re-renders, so without
     *  this a pinned card vanishes on the next keystroke/status push.
     *  (The redesign-era version accidentally survived this via a live
     *  for…of fanout feeding the new subscriber mid-iteration; that
     *  coupling is the same one that, once the per-keystroke status push
     *  was added, became an unbounded slot-remount freeze. The snapshot
     *  fix in setView/setStatusText broke the loop; this getter is the
     *  explicit, bounded replacement for the lost replay.) */
    currentView: () => PanelView | null;
    /** Tear down all subscribers. Called on plugin dispose. */
    dispose: () => void;
    // ── Status-line (A6) ─────────────────────────────────────────────
    /** Push a status-line text update. */
    setStatusText: (text: string) => void;
    /** Subscribe to status-line text updates. */
    subscribeStatus: (cb: (text: string) => void) => () => void;
    /** The last status text (or ""). Read at mount — see currentView. */
    currentStatus: () => string;
    // ── Mouse callbacks (A7) — set by the orchestrator ────────────────
    onApply?: () => void;
    onIgnore?: () => void;
    onUnpin?: () => void;
    onCycleNext?: () => void;
    onCyclePrev?: () => void;
    onRephraseAccept?: () => void;
    onRephraseReject?: () => void;
}

export function createDetailsPanelController(): PanelController {
    const subscribers = new Set<(next: PanelView | null) => void>();
    const statusSubscribers = new Set<(text: string) => void>();
    // Current values — held so a freshly-mounted PanelComponent can
    // INITIALIZE from them (the host re-invokes the slot fn on prompt
    // re-renders, remounting PanelComponent with a null-default local
    // signal; reading these on mount restores the live card/status).
    let lastView: PanelView | null = null;
    let lastStatus = "";
    return {
        setView(next) {
            lastView = next;
            // Snapshot before fanout: a subscriber callback can synchronously
            // re-invoke the host slot fn, which mounts a fresh PanelComponent
            // that calls subscribe() — adding to this Set MID-ITERATION. A
            // live `for…of` over a Set visits elements added during iteration,
            // so without the snapshot a single setView can spin unbounded
            // (slot-fn ↔ panel-remount storm → synchronous freeze).
            for (const cb of [...subscribers]) {
                cb(next);
            }
        },
        subscribe(cb) {
            subscribers.add(cb);
            return () => {
                subscribers.delete(cb);
            };
        },
        currentView: () => lastView,
        dispose() {
            subscribers.clear();
            statusSubscribers.clear();
            lastView = null;
            lastStatus = "";
        },
        setStatusText(text) {
            lastStatus = text;
            // Snapshot before fanout — see setView's note. The status path is
            // where this actually bit: pushStatusLine → setStatusText fans out
            // to a subscriber that re-mounts PanelComponent → subscribeStatus
            // re-adds to this Set mid-iteration → unbounded slot re-render.
            for (const cb of [...statusSubscribers]) {
                cb(text);
            }
        },
        subscribeStatus(cb) {
            statusSubscribers.add(cb);
            return () => {
                statusSubscribers.delete(cb);
            };
        },
        currentStatus: () => lastStatus,
    };
}
