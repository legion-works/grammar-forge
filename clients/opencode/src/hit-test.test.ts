import { describe, expect, test } from "vitest";
import { hitTestEndInclusive } from "./hit-test";

describe("hitTestEndInclusive", () => {
    test("EXACT BUG REGRESSION: offset == span.end pins that span (was end-exclusive)", () => {
        // Pre-fix: this returned null. Post-fix: returns 0.
        const spans = [{ start: 2, end: 5 }];
        expect(hitTestEndInclusive(5, spans)).toBe(0);
    });

    test("offset strictly inside a span pins it", () => {
        const spans = [{ start: 2, end: 5 }];
        expect(hitTestEndInclusive(3, spans)).toBe(0);
        expect(hitTestEndInclusive(2, spans)).toBe(0); // start inclusive
    });

    test("offset > all span ends → null (no match)", () => {
        const spans = [
            { start: 2, end: 5 },
            { start: 8, end: 12 },
        ];
        expect(hitTestEndInclusive(13, spans)).toBeNull();
        expect(hitTestEndInclusive(100, spans)).toBeNull();
    });

    test("offset < first span start → null (no match)", () => {
        const spans = [{ start: 2, end: 5 }];
        expect(hitTestEndInclusive(0, spans)).toBeNull();
        expect(hitTestEndInclusive(1, spans)).toBeNull();
    });

    test("empty spans → null", () => {
        expect(hitTestEndInclusive(5, [])).toBeNull();
    });

    test("two adjacent spans sharing a boundary → LEFT span wins", () => {
        // offset == end of span A == start of span B. Ascending
        // start sort + first-match-wins → span A (left) wins.
        const spans = [
            { start: 0, end: 5 },
            { start: 5, end: 10 },
        ];
        expect(hitTestEndInclusive(5, spans)).toBe(0);
    });

    test("three spans: mid-span click + end click + adjacent-boundary click", () => {
        const spans = [
            { start: 0, end: 4 }, // 0-4 inclusive
            { start: 6, end: 9 }, // 6-9 inclusive
            { start: 11, end: 15 }, // 11-15 inclusive
        ];
        expect(hitTestEndInclusive(2, spans)).toBe(0); // inside [0,4]
        expect(hitTestEndInclusive(4, spans)).toBe(0); // end of [0,4]
        expect(hitTestEndInclusive(6, spans)).toBe(1); // start of [6,9] (only second match, first loop is over)
        expect(hitTestEndInclusive(9, spans)).toBe(1); // end of [6,9]
        expect(hitTestEndInclusive(11, spans)).toBe(2); // start of [11,15]
        expect(hitTestEndInclusive(5, spans)).toBeNull(); // gap between [0,4] and [6,9]
        expect(hitTestEndInclusive(10, spans)).toBeNull(); // gap between [6,9] and [11,15]
    });
});
