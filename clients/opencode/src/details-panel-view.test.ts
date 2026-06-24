import { describe, expect, test } from "vitest";
import { createDetailsPanelController, type PanelView } from "./details-panel-view";

describe("createDetailsPanelController", () => {
    test("starts with no subscribers (no fanout)", () => {
        const c = createDetailsPanelController();
        let called = 0;
        // No setView was called yet, so no fanout to test — the
        // contract is "subscribers receive the payload that was
        // setView'd". A subscriber added before setView will
        // only get future calls (no replay).
        c.subscribe(() => called++);
        expect(called).toBe(0);
    });

    test("setView fans out to all subscribers synchronously", () => {
        const c = createDetailsPanelController();
        const received: Array<PanelView | null> = [];
        c.subscribe((next) => received.push(next));
        c.subscribe((next) => received.push(next));
        c.setView({
            kind: "suggestion",
            item: { category: "grammar", original: "teh", replacement: "the" },
            index: 0,
            total: 3,
            displayStart: 0,
            cycleNextKey: ".",
            cyclePrevKey: "/",
        });
        expect(received).toHaveLength(2);
        expect(received[0]).toEqual({
            kind: "suggestion",
            item: { category: "grammar", original: "teh", replacement: "the" },
            index: 0,
            total: 3,
            displayStart: 0,
            cycleNextKey: ".",
            cyclePrevKey: "/",
        });
        expect(received[1]).toEqual(received[0]);
    });

    test("setView(null) fans out the unpin payload to all subscribers", () => {
        const c = createDetailsPanelController();
        let last: PanelView | null = {
            kind: "suggestion",
            item: { category: "x", original: "x", replacement: "x" },
            index: 0,
            total: 1,
            displayStart: 0,
            cycleNextKey: ".",
            cyclePrevKey: "/",
        };
        c.subscribe((next) => {
            last = next;
        });
        c.setView(null);
        expect(last).toBeNull();
    });

    test("subscribe returns an unsubscribe function; unsubscribed callback doesn't fire", () => {
        const c = createDetailsPanelController();
        let called = 0;
        const unsub = c.subscribe(() => called++);
        c.setView({
            kind: "suggestion",
            item: { category: "x", original: "x", replacement: "x" },
            index: 0,
            total: 1,
            displayStart: 0,
            cycleNextKey: ".",
            cyclePrevKey: "/",
        });
        expect(called).toBe(1);
        unsub();
        c.setView(null);
        expect(called).toBe(1); // no increment
    });

    test("multiple subscribers each receive the same payload (orthogonal listeners)", () => {
        const c = createDetailsPanelController();
        const a: Array<PanelView | null> = [];
        const b: Array<PanelView | null> = [];
        c.subscribe((next) => a.push(next));
        c.subscribe((next) => b.push(next));
        c.setView({
            kind: "suggestion",
            item: { category: "spelling", original: "abc", replacement: "x" },
            index: 1,
            total: 2,
            displayStart: 0,
            cycleNextKey: ".",
            cyclePrevKey: "/",
        });
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
        expect(a[0]).toEqual(b[0]);
    });

    test("REGRESSION GUARD: subscribers always receive a concrete object or null, NEVER undefined", () => {
        // The dead-field class of bug: the old imperative render
        // path read vm.headerLine etc. and produced undefined
        // strings. The fanout must always pass a concrete
        // PanelView or null to subscribers.
        const c = createDetailsPanelController();
        const received: Array<PanelView | null | undefined> = [];
        c.subscribe((next) => received.push(next));
        c.setView({
            kind: "suggestion",
            item: { category: "spelling", original: "x", replacement: "y" },
            index: 0,
            total: 1,
            displayStart: 0,
            cycleNextKey: ".",
            cyclePrevKey: "/",
        });
        c.setView(null);
        expect(received).toHaveLength(2);
        expect(received[0]).not.toBeUndefined();
        expect(received[0]).not.toBeNull();
        expect(received[1]).toBeNull();
        const first = received[0];
        if (first !== null && first !== undefined && first.kind === "suggestion") {
            expect(typeof first.item.category).toBe("string");
            expect(typeof first.item.original).toBe("string");
            expect(typeof first.item.replacement).toBe("string");
            expect(typeof first.item.isDeletion).toBe("undefined");
            expect(typeof first.index).toBe("number");
            expect(typeof first.total).toBe("number");
            expect(typeof first.displayStart).toBe("number");
            expect(typeof first.cycleNextKey).toBe("string");
            expect(typeof first.cyclePrevKey).toBe("string");
        }
    });

    test("dispose clears all subscribers; setView after dispose is a no-op", () => {
        const c = createDetailsPanelController();
        let called = 0;
        c.subscribe(() => called++);
        c.setView({
            kind: "suggestion",
            item: { category: "x", original: "x", replacement: "x" },
            index: 0,
            total: 1,
            displayStart: 0,
            cycleNextKey: ".",
            cyclePrevKey: "/",
        });
        expect(called).toBe(1);
        c.dispose();
        c.setView(null);
        c.setView({
            kind: "suggestion",
            item: { category: "x", original: "x", replacement: "x" },
            index: 0,
            total: 1,
            displayStart: 0,
            cycleNextKey: ".",
            cyclePrevKey: "/",
        });
        expect(called).toBe(1);
    });

    test("dispose doesn't throw when called with no subscribers", () => {
        const c = createDetailsPanelController();
        expect(() => c.dispose()).not.toThrow();
    });

    // ── Re-entrant fanout guard (the 2026-06-24 freeze) ──────────────────
    // The OpenCode TUI froze hard (prompt unusable, ctrl+c dead, kill the
    // terminal) because setView/setStatusText iterated the subscriber Set with
    // a live `for…of`. A subscriber callback synchronously re-invoked the host
    // @opentui/solid slot fn → mounted a fresh PanelComponent → whose render
    // body calls subscribe()/subscribeStatus() → adds a NEW (distinct) callback
    // to the SAME Set mid-iteration. JS `for…of` over a Set VISITS entries added
    // during iteration, so a re-subscribing callback chain never terminates:
    // ~21,568 slot re-mounts in ~1ms = synchronous event-loop starvation. The
    // fix is to snapshot the listener collection before fanout. These guards
    // assert the fanout is bounded to the subscribers present at call time — a
    // mid-fanout subscribe must NOT be visited by the in-flight fanout.
    test("REGRESSION GUARD (freeze): setView snapshots subscribers — a re-subscribing callback cannot grow the in-flight fanout", () => {
        const c = createDetailsPanelController();
        let calls = 0;
        const SAFETY_CAP = 5000; // keep THIS test from hanging if the fix regresses
        const reSubscribe = (): void => {
            calls++;
            // Fresh closure each time — mirrors a new PanelComponent's setLocalView.
            if (calls < SAFETY_CAP) c.subscribe(() => reSubscribe());
        };
        c.subscribe(() => reSubscribe());
        c.setView(null);
        // Snapshot fix → exactly ONE call (the subscriber present at fanout time).
        // Without the snapshot, the live for…of follows the chain to SAFETY_CAP.
        expect(calls).toBe(1);
    });

    test("REGRESSION GUARD (freeze): setStatusText snapshots subscribers — the status path where the freeze actually bit", () => {
        const c = createDetailsPanelController();
        let calls = 0;
        const SAFETY_CAP = 5000;
        const reSubscribe = (): void => {
            calls++;
            if (calls < SAFETY_CAP) c.subscribeStatus(() => reSubscribe());
        };
        c.subscribeStatus(() => reSubscribe());
        c.setStatusText("x");
        expect(calls).toBe(1);
    });

    // ── Mount-restores-current-value guard (the 2026-06-24 disappearing card) ──
    // The host re-invokes the slot fn on prompt re-renders, re-mounting
    // PanelComponent with a fresh default signal. The redesign-era code
    // accidentally survived this because a LIVE for…of fanout fed the new
    // subscriber the card mid-iteration; the snapshot fix (above) removed that
    // accidental feed, so a re-mounted PanelComponent reset its localView to
    // null → the pinned card vanished on the next keystroke/status push. The
    // fix is explicit: the controller holds the last value, and a fresh mount
    // reads currentView()/currentStatus() to restore the live state.
    test("REGRESSION GUARD (disappearing card): currentView replays the last setView to a freshly-mounted component", () => {
        const c = createDetailsPanelController();
        const card: PanelView = {
            kind: "suggestion",
            item: { category: "grammar", original: "has", replacement: "have" },
            index: 0,
            total: 2,
            displayStart: 2,
            cycleNextKey: ".",
            cyclePrevKey: "/",
        };
        expect(c.currentView()).toBeNull(); // nothing pinned yet
        c.setView(card);
        // A NEW PanelComponent mounting after the pin must see the card,
        // NOT null — this is what makes the card survive a slot re-invoke.
        expect(c.currentView()).toEqual(card);
        c.setView(null); // unpin
        expect(c.currentView()).toBeNull();
    });

    test("REGRESSION GUARD (disappearing card): currentStatus replays the last setStatusText", () => {
        const c = createDetailsPanelController();
        expect(c.currentStatus()).toBe("");
        c.setStatusText("▍ 2 issues");
        expect(c.currentStatus()).toBe("▍ 2 issues");
    });

    test("dispose resets currentView/currentStatus to baseline", () => {
        const c = createDetailsPanelController();
        c.setView({
            kind: "suggestion",
            item: { category: "x", original: "x", replacement: "y" },
            index: 0,
            total: 1,
            displayStart: 0,
            cycleNextKey: ".",
            cyclePrevKey: "/",
        });
        c.setStatusText("something");
        c.dispose();
        expect(c.currentView()).toBeNull();
        expect(c.currentStatus()).toBe("");
    });
});
