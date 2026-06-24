import { describe, expect, test } from "vitest";
import {
    lineLooksUnfinished,
    joinContinuation,
    currentGhostPayload,
    subscribeGhost,
    pushGhostPayload,
} from "./ghost-overlay";
import type { GhostPayload } from "./ghost-overlay";

describe("joinContinuation", () => {
    test("inserts a joining space between two word-ish sides", () => {
        // The bridge trims the continuation, so "the" + "lazy dog." would
        // render as "thelazy dog." without this.
        expect(joinContinuation("the", "lazy dog.")).toBe(" lazy dog.");
        expect(joinContinuation("I am writing to", "request a meeting")).toBe(
            " request a meeting",
        );
    });
    test("no space when the text already ends with whitespace", () => {
        expect(joinContinuation("the ", "lazy dog.")).toBe("lazy dog.");
    });
    test("no space when the continuation already starts with whitespace", () => {
        expect(joinContinuation("the", " lazy dog.")).toBe(" lazy dog.");
    });
    test("no space when the continuation starts with hugging punctuation", () => {
        expect(joinContinuation("the dog", ".")).toBe(".");
        expect(joinContinuation("cat", ", and")).toBe(", and");
        expect(joinContinuation("it", "'s mine")).toBe("'s mine");
        expect(joinContinuation("fn(x", ")")).toBe(")");
    });
    test("empty continuation or empty text → unchanged", () => {
        expect(joinContinuation("the", "")).toBe("");
        expect(joinContinuation("", "lazy")).toBe("lazy");
    });
});

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
    test("pushGhostPayload fans out to a subscribed setter", () => {
        const records: Array<GhostPayload | null> = [];
        const unsub = subscribeGhost((v) => records.push(v));

        pushGhostPayload({ text: "fox jumps", atOffset: 15 });
        expect(records).toHaveLength(1);
        expect(records[0]).toEqual({ text: "fox jumps", atOffset: 15 });

        pushGhostPayload(null);
        expect(records).toHaveLength(2);
        expect(records[1]).toBeNull();

        unsub();
        pushGhostPayload({ text: "after unsub", atOffset: 0 });
        expect(records).toHaveLength(2); // unsubscribed — no more updates
    });

    test("currentGhostPayload replays the last push to a freshly-mounted component", () => {
        // The disappearing-ghost regression: the host re-invokes the slot fn
        // and re-mounts GhostComponent. The OLD single-setter + idempotent
        // guard pinned the setter to the FIRST mount, so after a remount
        // pushGhostPayload updated a disposed signal and the ghost never
        // showed (completion result arrived, no overlay painted). Now a new
        // mount reads currentGhostPayload() to restore the live ghost.
        pushGhostPayload({ text: "live ghost", atOffset: 7 });
        // Simulate a fresh GhostComponent mount reading the current value:
        expect(currentGhostPayload()).toEqual({ text: "live ghost", atOffset: 7 });
        pushGhostPayload(null);
        expect(currentGhostPayload()).toBeNull();
    });

    test("EVERY live subscriber receives updates (a remount can't strand the push)", () => {
        const a: Array<GhostPayload | null> = [];
        const b: Array<GhostPayload | null> = [];
        const unsubA = subscribeGhost((v) => a.push(v));
        const unsubB = subscribeGhost((v) => b.push(v));
        pushGhostPayload({ text: "both", atOffset: 1 });
        expect(a).toEqual([{ text: "both", atOffset: 1 }]);
        expect(b).toEqual([{ text: "both", atOffset: 1 }]);
        unsubA();
        unsubB();
    });

    test("pushGhostPayload with no subscribers is a no-op (no crash)", () => {
        expect(() => pushGhostPayload({ text: "x", atOffset: 1 })).not.toThrow();
        expect(() => pushGhostPayload(null)).not.toThrow();
    });
});
