import { describe, expect, test } from "vitest";
import { createDetailsState } from "./details-state";

describe("pinnedIndex", () => {
    test("starts null", () => {
        const state = createDetailsState();
        expect(state.pinnedIndex()).toBeNull();
    });
});

describe("pin", () => {
    test("sets the pinned index", () => {
        const state = createDetailsState();
        state.pin(2);
        expect(state.pinnedIndex()).toBe(2);
    });
    test("re-pinning overwrites the prior index", () => {
        const state = createDetailsState();
        state.pin(0);
        state.pin(4);
        expect(state.pinnedIndex()).toBe(4);
    });
});

describe("unpin", () => {
    test("clears the pinned index", () => {
        const state = createDetailsState();
        state.pin(1);
        state.unpin();
        expect(state.pinnedIndex()).toBeNull();
    });
});

describe("cycle", () => {
    test("+1 wraps from last index back to 0", () => {
        const state = createDetailsState();
        state.pin(2);
        state.cycle(1, 3);
        expect(state.pinnedIndex()).toBe(0);
    });
    test("-1 wraps from index 0 to the last", () => {
        const state = createDetailsState();
        state.pin(0);
        state.cycle(-1, 3);
        expect(state.pinnedIndex()).toBe(2);
    });
    test("+1 mid-list advances without wrapping", () => {
        const state = createDetailsState();
        state.pin(1);
        state.cycle(1, 4);
        expect(state.pinnedIndex()).toBe(2);
    });
    test("-1 mid-list rewinds without wrapping", () => {
        const state = createDetailsState();
        state.pin(3);
        state.cycle(-1, 5);
        expect(state.pinnedIndex()).toBe(2);
    });
    test("no-op when nothing pinned", () => {
        const state = createDetailsState();
        state.cycle(1, 3);
        state.cycle(-1, 3);
        expect(state.pinnedIndex()).toBeNull();
    });
    test("no-op when itemCount is 0", () => {
        const state = createDetailsState();
        state.pin(0);
        state.cycle(1, 0);
        // pin(0) was an "out of range" pin — pre-cycle it's stale. The
        // brief says cycle(itemCount=0) is a no-op; the test pins first
        // so the assertion is purely about the cycle call, not pre-state.
        expect(state.pinnedIndex()).toBe(0);
        state.unpin();
        // Same: from a null pin, itemCount 0 must not pin.
        state.cycle(1, 0);
        expect(state.pinnedIndex()).toBeNull();
    });
});

describe("itemsChanged", () => {
    test("keeps a still-valid pin", () => {
        const state = createDetailsState();
        state.pin(2);
        state.itemsChanged(3);
        expect(state.pinnedIndex()).toBe(2);
    });
    test("clears an out-of-range pin (count dropped below pin)", () => {
        const state = createDetailsState();
        state.pin(2);
        state.itemsChanged(2);
        expect(state.pinnedIndex()).toBeNull();
    });
    test("clears an out-of-range pin (count grew, old pin still valid: keep)", () => {
        // Sanity check the keep-case from the other direction.
        const state = createDetailsState();
        state.pin(1);
        state.itemsChanged(5);
        expect(state.pinnedIndex()).toBe(1);
    });
    test("no-op when no pin is set", () => {
        const state = createDetailsState();
        state.itemsChanged(3);
        expect(state.pinnedIndex()).toBeNull();
    });
});

describe("subscribe", () => {
    test("fires on pin", () => {
        const state = createDetailsState();
        const fires: number[][] = [];
        state.subscribe(() => fires.push([state.pinnedIndex() ?? -1]));
        state.pin(0);
        expect(fires).toEqual([[0]]);
    });
    test("fires on unpin", () => {
        const state = createDetailsState();
        state.pin(1);
        const fires: (number | null)[] = [];
        state.subscribe(() => fires.push(state.pinnedIndex()));
        state.unpin();
        expect(fires).toEqual([null]);
    });
    test("fires on cycle (wrap)", () => {
        const state = createDetailsState();
        state.pin(2);
        const fires: number[] = [];
        state.subscribe(() => fires.push(state.pinnedIndex() ?? -1));
        state.cycle(1, 3);
        expect(fires).toEqual([0]);
    });
    test("fires on itemsChanged that clears", () => {
        const state = createDetailsState();
        state.pin(3);
        const fires: (number | null)[] = [];
        state.subscribe(() => fires.push(state.pinnedIndex()));
        state.itemsChanged(2);
        expect(fires).toEqual([null]);
    });
    test("does NOT fire on itemsChanged that keeps the pin", () => {
        const state = createDetailsState();
        state.pin(1);
        const fires: number[] = [];
        state.subscribe(() => fires.push(1));
        state.itemsChanged(5);
        expect(fires).toEqual([]);
    });
    test("itemsChanged with same count + same signature keeps the pin (no fire)", () => {
        const state = createDetailsState();
        state.pin(1);
        const fires: number[] = [];
        state.subscribe(() => fires.push(1));
        state.itemsChanged(3, ["a:0:b", "b:1:c", "c:2:d"]);
        // First call: signature snapshot established, no transition.
        expect(fires).toEqual([]);
        expect(state.pinnedIndex()).toBe(1);
        // Second call with same signatures: no transition, no fire.
        state.itemsChanged(3, ["a:0:b", "b:1:c", "c:2:d"]);
        expect(fires).toEqual([]);
        expect(state.pinnedIndex()).toBe(1);
    });
    test("itemsChanged with same count + different signature at pin index clears the pin (fires)", () => {
        const state = createDetailsState();
        state.pin(1);
        const fires: (number | null)[] = [];
        state.subscribe(() => fires.push(state.pinnedIndex()));
        // Establish the baseline signature at index 1.
        state.itemsChanged(3, ["a:0:b", "b:1:c", "c:2:d"]);
        // Now re-check produces a different replacement at the same
        // index — the pin is stale. Should clear + fire.
        state.itemsChanged(3, ["a:0:b", "b:1:CHANGED", "c:2:d"]);
        expect(fires).toEqual([null]);
        expect(state.pinnedIndex()).toBeNull();
    });
    test("itemsChanged out-of-range still clears the pin even when signatures match", () => {
        const state = createDetailsState();
        state.pin(3);
        const fires: (number | null)[] = [];
        state.subscribe(() => fires.push(state.pinnedIndex()));
        state.itemsChanged(2, ["a:0:b", "b:1:c"]);
        expect(fires).toEqual([null]);
        expect(state.pinnedIndex()).toBeNull();
    });
    test("does NOT fire on double-pin to the same index", () => {
        const state = createDetailsState();
        state.pin(2);
        const fires: number[] = [];
        state.subscribe(() => fires.push(1));
        state.pin(2);
        expect(fires).toEqual([]);
    });
    test("does NOT fire on unpin when null", () => {
        const state = createDetailsState();
        const fires: number[] = [];
        state.subscribe(() => fires.push(1));
        state.unpin();
        expect(fires).toEqual([]);
    });
    test("does NOT fire on cycle when nothing pinned", () => {
        const state = createDetailsState();
        const fires: number[] = [];
        state.subscribe(() => fires.push(1));
        state.cycle(1, 3);
        state.cycle(-1, 3);
        expect(fires).toEqual([]);
    });
    test("does NOT fire on cycle when itemCount is 0", () => {
        const state = createDetailsState();
        const fires: number[] = [];
        state.subscribe(() => fires.push(1));
        state.cycle(1, 0);
        expect(fires).toEqual([]);
    });
    test("unsubscribe stops further events", () => {
        const state = createDetailsState();
        const fires: number[] = [];
        const unsubscribe = state.subscribe(() => fires.push(1));
        state.pin(0);
        unsubscribe();
        state.pin(1);
        state.unpin();
        expect(fires).toEqual([1]);
    });
    test("multiple subscribers all fire", () => {
        const state = createDetailsState();
        const a: number[] = [];
        const b: number[] = [];
        state.subscribe(() => a.push(1));
        state.subscribe(() => b.push(1));
        state.pin(0);
        expect(a).toEqual([1]);
        expect(b).toEqual([1]);
    });
    test("an earlier-unsubscribed listener is dropped from later fires", () => {
        const state = createDetailsState();
        const a: number[] = [];
        const b: number[] = [];
        const unsubA = state.subscribe(() => a.push(1));
        state.subscribe(() => b.push(1));
        unsubA();
        state.pin(0);
        expect(a).toEqual([]);
        expect(b).toEqual([1]);
    });
});
