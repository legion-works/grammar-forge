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
            item: { category: "grammar", original: "teh", replacement: "the" },
            index: 0,
            total: 3,
            displayStart: 0,
        });
        expect(received).toHaveLength(2);
        expect(received[0]).toEqual({
            item: { category: "grammar", original: "teh", replacement: "the" },
            index: 0,
            total: 3,
            displayStart: 0,
        });
        expect(received[1]).toEqual(received[0]);
    });

    test("setView(null) fans out the unpin payload to all subscribers", () => {
        const c = createDetailsPanelController();
        let last: PanelView | null = {
            item: { category: "x", original: "x", replacement: "x" },
            index: 0,
            total: 1,
            displayStart: 0,
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
            item: { category: "x", original: "x", replacement: "x" },
            index: 0,
            total: 1,
            displayStart: 0,
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
            item: { category: "spelling", original: "abc", replacement: "x" },
            index: 1,
            total: 2,
            displayStart: 0,
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
            item: { category: "spelling", original: "x", replacement: "y" },
            index: 0,
            total: 1,
            displayStart: 0,
        });
        c.setView(null);
        expect(received).toHaveLength(2);
        expect(received[0]).not.toBeUndefined();
        expect(received[0]).not.toBeNull();
        expect(received[1]).toBeNull();
        if (received[0] !== null && received[0] !== undefined) {
            expect(typeof received[0].item.category).toBe("string");
            expect(typeof received[0].item.original).toBe("string");
            expect(typeof received[0].item.replacement).toBe("string");
            expect(typeof received[0].item.isDeletion).toBe("undefined");
            expect(typeof received[0].index).toBe("number");
            expect(typeof received[0].total).toBe("number");
            expect(typeof received[0].displayStart).toBe("number");
        }
    });

    test("dispose clears all subscribers; setView after dispose is a no-op", () => {
        const c = createDetailsPanelController();
        let called = 0;
        c.subscribe(() => called++);
        c.setView({
            item: { category: "x", original: "x", replacement: "x" },
            index: 0,
            total: 1,
            displayStart: 0,
        });
        expect(called).toBe(1);
        c.dispose();
        c.setView(null);
        c.setView({
            item: { category: "x", original: "x", replacement: "x" },
            index: 0,
            total: 1,
            displayStart: 0,
        });
        expect(called).toBe(1);
    });

    test("dispose doesn't throw when called with no subscribers", () => {
        const c = createDetailsPanelController();
        expect(() => c.dispose()).not.toThrow();
    });
});
