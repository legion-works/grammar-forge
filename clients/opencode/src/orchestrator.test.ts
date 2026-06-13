import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
    resolveSettings,
    suggestionsToDecorations,
    startOrchestrator,
    type Decoration,
    type OrchestratorDeps,
} from "./orchestrator";
import { makeDisplayWidth } from "./display-width";

describe("resolveSettings", () => {
    test("defaults when no options", () => {
        const s = resolveSettings(undefined);
        expect(s.bridgeUrl).toBe("http://localhost:8000");
        expect(s.realtimeDelayMs).toBe(500);
        expect(s.acceptHotkey).toBe("ctrl+.");
        expect(s.allowRemoteBridge).toBe(false);
    });
    test("honors valid overrides and strips trailing slash", () => {
        const s = resolveSettings({
            bridgeUrl: "http://127.0.0.1:9000/",
            realtimeDelayMs: 750,
            acceptHotkey: "alt+a",
            allowRemoteBridge: true,
        });
        expect(s.bridgeUrl).toBe("http://127.0.0.1:9000");
        expect(s.realtimeDelayMs).toBe(750);
        expect(s.acceptHotkey).toBe("alt+a");
        expect(s.allowRemoteBridge).toBe(true);
    });
    test("garbage values fall back to defaults", () => {
        const s = resolveSettings({
            bridgeUrl: 42,
            realtimeDelayMs: "fast",
            acceptHotkey: "   ",
            allowRemoteBridge: "yes",
        });
        expect(s.bridgeUrl).toBe("http://localhost:8000");
        expect(s.realtimeDelayMs).toBe(500);
        expect(s.acceptHotkey).toBe("ctrl+.");
        expect(s.allowRemoteBridge).toBe(false);
    });
});

// Stub per-segment width: ASCII = 1, surrogate-pair emoji = 2. Built via
// makeDisplayWidth so the newline-aware total-width fn is the SAME shape
// the production orchestrator constructs.
const stubSegment = (s: string): number => {
    const cp = s.codePointAt(0)!;
    return cp >= 0x1f000 ? 2 : 1;
};
const width = makeDisplayWidth(stubSegment);

describe("suggestionsToDecorations", () => {
    type ItemLike = { hlStart: number; hlEnd: number; category: string };

    test("maps cu→display (ASCII) and preserves itemIndex", () => {
        const items: ItemLike[] = [
            { hlStart: 1, hlEnd: 4, category: "grammar" },
            { hlStart: 6, hlEnd: 8, category: "spelling" },
        ];
        const out: Decoration[] = suggestionsToDecorations("hello world", items, [], width);
        expect(out).toEqual([
            { start: 1, end: 4, category: "grammar", itemIndex: 0 },
            { start: 6, end: 8, category: "spelling", itemIndex: 1 },
        ]);
    });
    test("drops empty spans and suggestions overlapping part ranges", () => {
        const items: ItemLike[] = [
            { hlStart: 0, hlEnd: 0, category: "grammar" }, // empty span
            { hlStart: 4, hlEnd: 7, category: "grammar" }, // overlaps part [2,6)
            { hlStart: 10, hlEnd: 14, category: "spelling" }, // clear
        ];
        const out = suggestionsToDecorations(
            "hello world foo",
            items,
            [{ start: 2, end: 6 }],
            width,
        );
        expect(out).toEqual([{ start: 10, end: 14, category: "spelling", itemIndex: 2 }]);
    });
    test("mid-grapheme END clamps UP so the target grapheme is included", () => {
        const items: ItemLike[] = [{ hlStart: 0, hlEnd: 1, category: "spelling" }];
        const out = suggestionsToDecorations("😀x", items, [], width);
        // hlStart=0 → display 0. hlEnd=1 lands mid-surrogate; end-mode clamps UP
        // to the grapheme's END (width 2) so the emoji is included.
        expect(out).toEqual([{ start: 0, end: 2, category: "spelling", itemIndex: 0 }]);
    });
});

describe("startOrchestrator", () => {
    // bunSegmentWidth is the production display-width source; it throws if
    // globalThis.Bun is missing. Stub a minimal Bun in the test so the
    // renderDecorations path actually runs (otherwise the runCheck try/catch
    // silently swallows the throw and the test "passes" for the wrong
    // reason).
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    beforeAll(() => {
        (globalThis as { Bun?: unknown }).Bun = { stringWidth: (s: string) => s.length };
    });
    afterAll(() => {
        if (originalBun === undefined) {
            delete (globalThis as { Bun?: unknown }).Bun;
        } else {
            (globalThis as { Bun?: unknown }).Bun = originalBun;
        }
    });

    test("unpatched build (no api.prompt) returns a disposer and toasts once", () => {
        const toasts: Array<{ message: string; variant?: string }> = [];
        const api = {
            prompt: undefined, // unpatched OpenCode build
            keymap: { registerLayer: () => () => undefined },
            ui: { toast: (t: { message: string; variant?: string }) => toasts.push(t) },
            theme: { syntax: () => null },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];
        const stop = startOrchestrator(api, undefined);
        expect(typeof stop).toBe("function");
        expect(toasts).toHaveLength(1);
        expect(toasts[0]?.message).toMatch(/prompt facade/i);
        // Disposer is safe to call (no-op).
        expect(() => stop()).not.toThrow();
    });

    test("stale runCheck (ref swap mid-flight) does not render to dead ref or pollute state", async () => {
        const makeRef = (text: string) => {
            const created: number[] = [];
            const deleted: number[] = [];
            const ref = {
                text,
                current: { input: text, parts: [] },
                extmarks: {
                    registerType: (_t: string) => 1,
                    create: (_o: object) => {
                        created.push(created.length + 1);
                        return created.length;
                    },
                    getAllForTypeId: (_t: number) => [],
                    delete: (id: number) => {
                        deleted.push(id);
                        return true;
                    },
                },
                getTextRange: (_s: number, _e: number) => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                _created: created,
                _deleted: deleted,
            };
            return ref;
        };
        const refA = makeRef("hello wor");
        const refB = makeRef("hello world");
        // refA text is 9 ASCII bytes; byte span {0,1} verifies and maps to
        // a word-level highlight over "hello". A real suggestion (not an
        // empty array) is what makes the bug observable — with
        // `suggestions: []` the broken pre-fix code would call
        // renderDecorations(refA, []) which creates NOTHING, so the test
        // would pass for the wrong reason.
        let currentRef: typeof refA = refA;
        let onChangeCb: () => void = () => undefined;
        type Resolver = (res: unknown) => void;
        const pending: Resolver[] = [];

        const api = {
            prompt: {
                ref: () => currentRef,
                onChange: (cb: () => void) => {
                    onChangeCb = cb;
                    return () => undefined;
                },
            },
            keymap: { registerLayer: () => () => undefined },
            ui: { toast: () => undefined },
            theme: {
                syntax: () => ({
                    registerStyle: () => 1,
                    getStyleId: () => 1,
                }),
            },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const stop = startOrchestrator(api, { realtimeDelayMs: 10 }, {
            correct: () =>
                new Promise<unknown>((resolve) => {
                    pending.push(resolve);
                }),
        } as unknown as OrchestratorDeps);

        // Initial mount → scheduleCheck(refA) → debounce 10ms → runCheck starts
        // → await on the (still-pending) correct call.
        await new Promise((r) => setTimeout(r, 30));
        expect(pending.length).toBe(1);

        // Route remount: ref identity changes, onChange fires, ensureRef
        // branch runs (and must bump state.checkSeq to invalidate the
        // in-flight check on the OLD ref).
        currentRef = refB;
        onChangeCb();

        // Resolve the OLD ref's fetch with a REAL suggestion that
        // buildRenderableItems turns into a renderable item. Shape mirrors
        // the browser fixture in clients/browser/src/lib/pipeline.test.ts
        // (span/replacement/model; verifyByteSpan accepts ASCII byte span
        // {0,1} against "hello wor"). Empty-suggestion responses would not
        // exercise the bug — the test would pass for the wrong reason.
        const resolve = pending.shift();
        expect(resolve).toBeDefined();
        resolve!({
            original: "hello wor",
            score: 90,
            suggestions: [{ id: 1, span: { start: 0, end: 1 }, replacement: "x", model: "harper" }],
        });

        // Drain microtasks so the post-await guard runs.
        await new Promise((r) => setTimeout(r, 0));

        // Assertions:
        //   - refA received NO extmark create calls (we must not render to a
        //     dead ref). This is the load-bearing assertion — pre-fix the
        //     stale runCheck would have called refA.extmarks.create().
        //   - refB received NO extmark create calls (state.items is empty
        //     after the ref-swap reset; no spurious render).
        //   - refB received NO extmark delete calls (no foreign ids from
        //     refA's controller leaking into B's clearActiveExtmarks).
        expect(refA._created).toEqual([]);
        expect(refB._created).toEqual([]);
        expect(refB._deleted).toEqual([]);

        stop();
    });
});
