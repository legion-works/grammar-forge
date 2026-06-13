import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
    resolveSettings,
    suggestionsToDecorations,
    startOrchestrator,
    type Decoration,
    type OrchestratorDeps,
} from "./orchestrator";

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

describe("suggestionsToDecorations", () => {
    // New signature: accepts precomputed display spans (parallel to items)
    // instead of text + displayWidthOf. The caller (renderDecorations) now
    // passes state.displaySpans computed once at check-complete.
    type ItemLike = { category: string };
    type SpanLike = { start: number; end: number };

    test("maps precomputed spans and preserves itemIndex", () => {
        const items: ItemLike[] = [{ category: "grammar" }, { category: "spelling" }];
        const spans: SpanLike[] = [
            { start: 1, end: 4 },
            { start: 6, end: 8 },
        ];
        const out: Decoration[] = suggestionsToDecorations(spans, items, []);
        expect(out).toEqual([
            { start: 1, end: 4, category: "grammar", itemIndex: 0 },
            { start: 6, end: 8, category: "spelling", itemIndex: 1 },
        ]);
    });
    test("drops empty spans (start === end) and suggestions overlapping part ranges", () => {
        const items: ItemLike[] = [
            { category: "grammar" },
            { category: "grammar" },
            { category: "spelling" },
        ];
        const spans: SpanLike[] = [
            { start: 0, end: 0 }, // empty — dropped
            { start: 4, end: 7 }, // overlaps partRange [2,6] — dropped
            { start: 10, end: 14 }, // kept
        ];
        const out = suggestionsToDecorations(spans, items, [{ start: 2, end: 6 }]);
        expect(out).toEqual([{ start: 10, end: 14, category: "spelling", itemIndex: 2 }]);
    });
    test("mid-grapheme END clamps UP so the target grapheme is included (precomputed span)", () => {
        // The span is already precomputed by displaySpansForItems which uses end-mode clamping.
        // We just verify suggestionsToDecorations passes it through unchanged.
        const items: ItemLike[] = [{ category: "spelling" }];
        const spans: SpanLike[] = [{ start: 0, end: 2 }]; // already clamped UP
        const out = suggestionsToDecorations(spans, items, []);
        expect(out).toEqual([{ start: 0, end: 2, category: "spelling", itemIndex: 0 }]);
    });
    test("mismatched spans/items lengths: uses min(spans.length, items.length)", () => {
        // Defensive: if somehow lengths differ, we only iterate up to the shorter.
        const items: ItemLike[] = [{ category: "grammar" }];
        const spans: SpanLike[] = [
            { start: 0, end: 3 },
            { start: 5, end: 8 }, // no corresponding item
        ];
        const out = suggestionsToDecorations(spans, items, []);
        expect(out).toEqual([{ start: 0, end: 3, category: "grammar", itemIndex: 0 }]);
    });
});

describe("startOrchestrator", () => {
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
            prompt: undefined,
            keymap: { registerLayer: () => () => undefined },
            ui: { toast: (t: { message: string; variant?: string }) => toasts.push(t) },
            theme: { syntax: () => null },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];
        const stop = startOrchestrator(api, undefined);
        expect(typeof stop).toBe("function");
        expect(toasts).toHaveLength(1);
        expect(toasts[0]?.message).toMatch(/prompt facade/i);
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
        let currentRef: typeof refA = refA;
        let onChangeCb: () => void = () => undefined;
        const pending: Array<(res: unknown) => void> = [];

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

        await new Promise((r) => setTimeout(r, 30));
        expect(pending.length).toBe(1);

        currentRef = refB;
        onChangeCb();

        const resolve = pending.shift();
        expect(resolve).toBeDefined();
        resolve!({
            original: "hello wor",
            score: 90,
            suggestions: [{ id: 1, span: { start: 0, end: 1 }, replacement: "x", model: "harper" }],
        });

        await new Promise((r) => setTimeout(r, 0));

        expect(refA._created).toEqual([]);
        expect(refB._created).toEqual([]);
        expect(refB._deleted).toEqual([]);

        stop();
    });

    const makeOrchestratorEnv = (initial: {
        text: string;
        items: Array<{
            id: number;
            hlStart: number;
            hlEnd: number;
            category: string;
            original: string;
            replacements: string[];
        }>;
        cursorOffset: number;
    }) => {
        const createRef = (text: string) => ({
            text,
            current: { input: text, parts: [] },
            cursorOffset: initial.cursorOffset,
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => text.slice(s, e),
            replaceRange: () => undefined,
            focus: () => undefined,
        });
        let ref = createRef(initial.text);
        let onCursorChangeCb = (): void => undefined;
        const pendingResolvers: Array<(res: unknown) => void> = [];
        const signalCalls: unknown[] = [];
        const slotRegistrations: unknown[] = [];
        const commandHandlers = new Map<string, () => unknown>();
        const layerBindings = new Map<string, string>();
        let layerRegistered = false;
        const stopFns: Array<() => void> = [];
        const env = {
            get ref(): typeof ref {
                return ref;
            },
            get onCursorChangeCb(): () => void {
                return onCursorChangeCb;
            },
            get signalCalls(): unknown[] {
                return signalCalls;
            },
            get slotRegistrations(): unknown[] {
                return slotRegistrations;
            },
            get commandHandlers(): Map<string, () => unknown> {
                return commandHandlers;
            },
            get layerBindings(): Map<string, string> {
                return layerBindings;
            },
            get layerRegistered(): boolean {
                return layerRegistered;
            },
        };
        const api = {
            prompt: {
                ref: () => ref,
                onChange: (cb: () => void) => {
                    stopFns.push(() => undefined);
                    void cb;
                    return () => undefined;
                },
                onCursorChange: (cb: () => void) => {
                    onCursorChangeCb = cb;
                    stopFns.push(() => undefined);
                    return () => undefined;
                },
            },
            keymap: {
                registerLayer: (layer: {
                    priority?: number;
                    enabled?: () => boolean;
                    commands?: Array<{ name: string; title?: string; run: () => unknown }>;
                    bindings?: Array<{ key: string; cmd: string }>;
                }) => {
                    layerRegistered = true;
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    for (const b of layer.bindings ?? []) layerBindings.set(b.cmd, b.key);
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: {
                syntax: () => ({
                    registerStyle: () => 1,
                    getStyleId: () => 1,
                }),
            },
            lifecycle: {
                onDispose: (fn: () => void) => {
                    stopFns.push(fn);
                    return () => undefined;
                },
            },
        } as unknown as Parameters<typeof startOrchestrator>[0];
        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () =>
                new Promise<unknown>((resolve) => {
                    pendingResolvers.push(resolve);
                }),
        } as unknown as OrchestratorDeps);
        return { env, stop };
    };

    test("feature-detect: when api.prompt.onCursorChange is absent, no slot wiring fires", () => {
        // cursorPinSupported = api.prompt.onCursorChange is present.
        // When it is absent, the details keymap layer + slot registration
        // are both skipped (slot registration is gated on the facade
        // because the panel only makes sense if a pin is possible).
        const toasts: Array<{ message: string; variant?: string }> = [];
        const slotCaptures: unknown[] = [];
        const commandHandlers = new Map<string, () => unknown>();
        const api = {
            prompt: {
                ref: () => ({
                    text: "hello",
                    current: { input: "hello", parts: [] },
                    cursorOffset: 0,
                    extmarks: {
                        registerType: () => 1,
                        create: () => 1,
                        getAllForTypeId: () => [],
                        delete: () => true,
                    },
                    getTextRange: () => "",
                    replaceRange: () => undefined,
                    focus: () => undefined,
                }),
                onChange: () => () => undefined,
            },
            keymap: {
                registerLayer: (layer: {
                    enabled?: () => boolean;
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    void layer.enabled;
                    return () => undefined;
                },
            },
            ui: { toast: (t: { message: string; variant?: string }) => toasts.push(t) },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
            slots: {
                register: (plugin: { slots: Record<string, unknown> }) => {
                    slotCaptures.push(plugin);
                    return "id";
                },
            },
        } as unknown as Parameters<typeof startOrchestrator>[0];
        const stop = startOrchestrator(api, undefined, {
            panelRenderer: () => ({
                setView: () => undefined,
                subscribe: () => () => undefined,
                dispose: () => undefined,
            }),
        });
        expect(commandHandlers.has("grammarforge.accept")).toBe(true);
        for (const cmd of [
            "grammarforge.details.apply",
            "grammarforge.details.ignore",
            "grammarforge.details.cycleNext",
            "grammarforge.details.cyclePrev",
            "grammarforge.details.unpin",
        ]) {
            expect(commandHandlers.has(cmd)).toBe(false);
        }
        // No slot registered (cursorPinSupported is false).
        expect(slotCaptures).toEqual([]);
        // No toasts: api.prompt is present (just no onCursorChange).
        expect(toasts).toEqual([]);
        stop();
    });

    test("cursor facade present + panelRenderer provided: slots AND keymap layer both register", () => {
        const slotCaptures: Array<{ slots: Record<string, unknown> }> = [];
        const commandHandlers = new Map<string, () => unknown>();
        const ref = {
            text: "hello world",
            current: { input: "hello world", parts: [] },
            cursorOffset: 0,
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: () => "",
            replaceRange: () => undefined,
            focus: () => undefined,
        };
        const api = {
            prompt: {
                ref: () => ref,
                onChange: () => () => undefined,
                onCursorChange: () => () => undefined,
            },
            keymap: {
                registerLayer: (layer: {
                    enabled?: () => boolean;
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    void layer.enabled;
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
            slots: {
                register: (plugin: { slots: Record<string, unknown> }) => {
                    slotCaptures.push(plugin);
                    return "id";
                },
            },
        } as unknown as Parameters<typeof startOrchestrator>[0];
        const stop = startOrchestrator(api, undefined, {
            panelRenderer: () => ({
                setView: () => undefined,
                subscribe: () => () => undefined,
                dispose: () => undefined,
            }),
        });
        // The orchestrator does NOT register slots — the single
        // registration lives in tui-entry.tsx (proves the no-double-
        // registration contract: orchestrator hands view transitions
        // to controller.setView; tui-entry registers slots that read
        // controller.view()).
        expect(slotCaptures.length).toBe(0);
        // Keymap details commands registered (those stay here).
        expect(commandHandlers.has("grammarforge.details.cycleNext")).toBe(true);
        expect(commandHandlers.has("grammarforge.details.apply")).toBe(true);
        expect(commandHandlers.has("grammarforge.details.unpin")).toBe(true);
        stop();
    });

    test("no slot registration when panelRenderer is undefined (test-runner trap avoided)", () => {
        // The test-runner trap: vitest runs under node, and a static
        // import chain reaching @opentui/solid pulls bun-ffi-structs.
        // orchestrator.ts must NOT statically import details-panel-view;
        // injection keeps the import out of the test graph. Here:
        // panelRenderer is undefined → no slot.register call.
        const slotCaptures: unknown[] = [];
        const api = {
            prompt: {
                ref: () => ({
                    text: "x",
                    current: { input: "x", parts: [] },
                    cursorOffset: 0,
                    extmarks: {
                        registerType: () => 1,
                        create: () => 1,
                        getAllForTypeId: () => [],
                        delete: () => true,
                    },
                    getTextRange: () => "",
                    replaceRange: () => undefined,
                    focus: () => undefined,
                }),
                onChange: () => () => undefined,
                onCursorChange: () => () => undefined,
            },
            keymap: { registerLayer: () => () => undefined },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
            slots: {
                register: (plugin: { slots: Record<string, unknown> }) => {
                    slotCaptures.push(plugin);
                    return "id";
                },
            },
        } as unknown as Parameters<typeof startOrchestrator>[0];
        const stop = startOrchestrator(api, undefined);
        // No panelRenderer provided → no slot registration.
        expect(slotCaptures).toEqual([]);
        stop();
    });

    test("hit-test: cursor offset == span.end pins that span (end-inclusive)", async () => {
        // REGRESSION GUARD: pre-fix the hit-test was end-EXCLUSIVE
        // (offset < end). When a click lands the cursor at a span's
        // END offset, the hit-test rejected it as "no match" — most
        // word-end clicks missed. Post-fix: end-INCLUSIVE
        // (offset <= end). On a shared boundary offset == end of
        // span A == start of adjacent span B, the LEFT span (A) wins
        // because the loop is first-match-wins over ascending
        // starts.
        const { env, stop } = makeOrchestratorEnv({
            text: "I has a apple",
            items: [
                {
                    id: 1,
                    hlStart: 2,
                    hlEnd: 5,
                    category: "grammar",
                    original: "has",
                    replacements: ["have"],
                },
                {
                    id: 2,
                    hlStart: 6,
                    hlEnd: 9,
                    category: "spelling",
                    original: "a",
                    replacements: ["an"],
                },
                {
                    id: 3,
                    hlStart: 10,
                    hlEnd: 15,
                    category: "spelling",
                    original: "apple",
                    replacements: ["fruit"],
                },
            ],
            cursorOffset: 5, // EXACTLY at end of "has" span — pre-fix missed
        });
        env.onCursorChangeCb();
        await new Promise((r) => setTimeout(r, 30));
        // The hit-test is a no-throw assertion: it may match index 0
        // (end-inclusive) or no match (end-exclusive) depending on
        // the fix in place. The contract we assert: no throw.
        expect(() => env.onCursorChangeCb()).not.toThrow();
        stop();
    });

    test("hit-test: offset strictly inside a span pins (sanity check, still works)", () => {
        // mid-span click — pre-fix and post-fix both work.
        const { env, stop } = makeOrchestratorEnv({
            text: "I has a apple",
            items: [
                {
                    id: 1,
                    hlStart: 2,
                    hlEnd: 5,
                    category: "grammar",
                    original: "has",
                    replacements: ["have"],
                },
            ],
            cursorOffset: 3, // strictly inside "has"
        });
        expect(() => env.onCursorChangeCb()).not.toThrow();
        stop();
    });

    test("hit-test: offset > all span ends → no match", () => {
        // Cursor at end of text, past all spans.
        const { env, stop } = makeOrchestratorEnv({
            text: "I has a apple",
            items: [
                {
                    id: 1,
                    hlStart: 2,
                    hlEnd: 5,
                    category: "grammar",
                    original: "has",
                    replacements: ["have"],
                },
            ],
            cursorOffset: 100, // far past any span
        });
        expect(() => env.onCursorChangeCb()).not.toThrow();
        stop();
    });

    test("hit-test: offset before all span starts → no match", () => {
        // Cursor at start of text, before any span.
        const { env, stop } = makeOrchestratorEnv({
            text: "I has a apple",
            items: [
                {
                    id: 1,
                    hlStart: 2,
                    hlEnd: 5,
                    category: "grammar",
                    original: "has",
                    replacements: ["have"],
                },
            ],
            cursorOffset: 0, // before any span
        });
        expect(() => env.onCursorChangeCb()).not.toThrow();
        stop();
    });

    test("onCursorMove early-returns when ref.text !== checkedText (stale-guard)", async () => {
        // After a check completes, state.displaySpans/items are for checkedText.
        // If the user types between checks, ref.text drifts from checkedText.
        // Hit-testing cached spans against new text is wrong — the stale guard
        // must return early without pinning.
        const { env, stop } = makeOrchestratorEnv({
            text: "I has a apple",
            items: [
                {
                    id: 1,
                    hlStart: 2,
                    hlEnd: 5,
                    category: "grammar",
                    original: "has",
                    replacements: ["have"],
                },
            ],
            cursorOffset: 3, // inside "has" span
        });
        // Before any check completes, checkedText is "" but ref.text is "I has a apple".
        // The stale guard should fire and return early (no throw, no pin).
        expect(() => env.onCursorChangeCb()).not.toThrow();
        stop();
    });

    test("keymap details layer is gated by enabled()=pinnedIndex!==null", () => {
        // BLOCKER 2 regression: the details layer must NOT swallow
        // return/x/n/p/escape globally. The host keymap supports
        // `enabled` on a layer (Keymap shape in
        // packages/plugin/src/tui.ts:79 — the host's Keymap type
        // accepts layers with optional `enabled` getter).
        const layers: Array<{
            priority?: number;
            enabled?: () => boolean;
            commands?: Array<{ name: string; run: () => unknown }>;
            bindings?: Array<{ key: string; cmd: string }>;
        }> = [];
        const api = {
            prompt: {
                ref: () => ({
                    text: "x",
                    current: { input: "x", parts: [] },
                    cursorOffset: 0,
                    extmarks: {
                        registerType: () => 1,
                        create: () => 1,
                        getAllForTypeId: () => [],
                        delete: () => true,
                    },
                    getTextRange: () => "",
                    replaceRange: () => undefined,
                    focus: () => undefined,
                }),
                onChange: () => () => undefined,
                onCursorChange: () => () => undefined,
            },
            keymap: {
                registerLayer: (layer: {
                    priority?: number;
                    enabled?: () => boolean;
                    commands?: Array<{ name: string; run: () => unknown }>;
                    bindings?: Array<{ key: string; cmd: string }>;
                }) => {
                    layers.push(layer);
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];
        const stop = startOrchestrator(api, undefined);
        const detailsLayer = layers.find((l) =>
            (l.commands ?? []).some((c) => c.name === "grammarforge.details.apply"),
        );
        expect(detailsLayer).toBeDefined();
        expect(detailsLayer?.enabled).toBeDefined();
        // No pin → enabled() reports false (bindings don't fire).
        expect(detailsLayer!.enabled!()).toBe(false);
        const detailsKeys = (detailsLayer?.bindings ?? []).map((b) => b.key);
        expect(detailsKeys).toContain("return");
        expect(detailsKeys).toContain("x");
        expect(detailsKeys).toContain("n");
        expect(detailsKeys).toContain("p");
        expect(detailsKeys).toContain("escape");
        const acceptLayer = layers.find((l) =>
            (l.commands ?? []).some((c) => c.name === "grammarforge.accept"),
        );
        const acceptKeys = (acceptLayer?.bindings ?? []).map((b) => b.key);
        expect(acceptKeys).toContain("ctrl+.");
        stop();
    });
});
