import { describe, expect, test } from "vitest";
import { lineLooksUnfinished, initGhostSignal, pushGhostPayload } from "./ghost-overlay";
import type { GhostPayload } from "./ghost-overlay";

describe("lineLooksUnfinished", () => {
    test("true for mid-sentence text", () => {
        expect(lineLooksUnfinished("The quick brown")).toBe(true);
        expect(lineLooksUnfinished('He said, "hello')).toBe(true);
        expect(lineLooksUnfinished("function foo(")).toBe(true);
        expect(lineLooksUnfinished("const x =")).toBe(true);
        expect(lineLooksUnfinished("abc")).toBe(true); // exactly 3 chars
    });
    test("false for terminal punctuation", () => {
        expect(lineLooksUnfinished("The quick brown fox.")).toBe(false);
        expect(lineLooksUnfinished("What time is it?")).toBe(false);
        expect(lineLooksUnfinished("Run!")).toBe(false);
        expect(lineLooksUnfinished("Options:")).toBe(false);
        expect(lineLooksUnfinished("Finish;")).toBe(false);
    });
    test("false for empty or whitespace-only", () => {
        expect(lineLooksUnfinished("")).toBe(false);
        expect(lineLooksUnfinished("   ")).toBe(false);
        expect(lineLooksUnfinished("\n\t")).toBe(false);
    });
    test("false for short text (<3 chars)", () => {
        expect(lineLooksUnfinished("ab")).toBe(false);
        expect(lineLooksUnfinished(" x")).toBe(false);
        expect(lineLooksUnfinished("a")).toBe(false);
    });
    test("non-terminal punctuation does not block", () => {
        expect(lineLooksUnfinished("hello,")).toBe(true);
        expect(lineLooksUnfinished('say "')).toBe(true);
        expect(lineLooksUnfinished("ax-")).toBe(true);
        expect(lineLooksUnfinished("foo)")).toBe(true);
    });
});

describe("ghost signal bridge", () => {
    test("pushGhostPayload calls the signal setter wired by initGhostSignal", () => {
        const records: Array<GhostPayload | null> = [];
        // Simulate what GhostComponent does at mount.
        initGhostSignal(
            () => records[records.length - 1] ?? null,
            (v) => records.push(v),
        );

        // First push: ghost text.
        pushGhostPayload({ text: "fox jumps", atOffset: 15 });
        expect(records).toHaveLength(1);
        expect(records[0]).toEqual({ text: "fox jumps", atOffset: 15 });

        // Second push: clear (null).
        pushGhostPayload(null);
        expect(records).toHaveLength(2);
        expect(records[1]).toBeNull();

        // Re-init is idempotent — no-op, records unchanged.
        const altRecords: Array<GhostPayload | null> = [];
        initGhostSignal(
            () => altRecords[altRecords.length - 1] ?? null,
            (v) => altRecords.push(v),
        );
        pushGhostPayload({ text: "second", atOffset: 0 });
        // Still uses the FIRST setter (idempotent guard).
        expect(altRecords).toHaveLength(0);
        expect(records).toHaveLength(3);
        expect(records[2]).toEqual({ text: "second", atOffset: 0 });
    });

    test("pushGhostPayload before initGhostSignal is a no-op (no crash)", () => {
        // No initGhostSignal call — module-level setter is null.
        // pushGhostPayload must not throw.
        expect(() => pushGhostPayload({ text: "x", atOffset: 1 })).not.toThrow();
        expect(() => pushGhostPayload(null)).not.toThrow();
    });
});
