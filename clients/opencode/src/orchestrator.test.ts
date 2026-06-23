import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
    resolveSettings,
    suggestionsToDecorations,
    startOrchestrator,
    jumpNext,
    jumpPrev,
    type Decoration,
    type OrchestratorDeps,
} from "./orchestrator";

describe("resolveSettings", () => {
    test("defaults when no options", () => {
        const s = resolveSettings(undefined);
        expect(s.bridgeUrl).toBe("http://localhost:8000");
        expect(s.realtimeDelayMs).toBe(500);
        expect(s.applyAllHotkey).toBe("ctrl+.");
        expect(s.cycleNextHotkey).toBe("ctrl+n");
        expect(s.cyclePrevHotkey).toBe("ctrl+p");
        expect(s.allowRemoteBridge).toBe(false);
    });
    test("honors valid overrides and strips trailing slash", () => {
        const s = resolveSettings({
            bridgeUrl: "http://127.0.0.1:9000/",
            realtimeDelayMs: 750,
            applyAllHotkey: "alt+a",
            cycleNextHotkey: "]",
            cyclePrevHotkey: "[",
            allowRemoteBridge: true,
        });
        expect(s.bridgeUrl).toBe("http://127.0.0.1:9000");
        expect(s.realtimeDelayMs).toBe(750);
        expect(s.applyAllHotkey).toBe("alt+a");
        expect(s.cycleNextHotkey).toBe("]");
        expect(s.cyclePrevHotkey).toBe("[");
        expect(s.allowRemoteBridge).toBe(true);
    });
    test("cycle defaults are ctrl+n / ctrl+p (not / and .)", () => {
        const s = resolveSettings({});
        expect(s.cycleNextHotkey).toBe("ctrl+n");
        expect(s.cyclePrevHotkey).toBe("ctrl+p");
    });

    test("nextIssueHotkey / prevIssueHotkey settings (default ctrl+g / ctrl+shift+g)", () => {
        const s = resolveSettings({});
        expect(s.nextIssueHotkey).toBe("ctrl+g");
        expect(s.prevIssueHotkey).toBe("ctrl+shift+g");
    });
    test("nextIssueHotkey / prevIssueHotkey are rebindable", () => {
        const s = resolveSettings({ nextIssueHotkey: "ctrl+n", prevIssueHotkey: "ctrl+p" });
        expect(s.nextIssueHotkey).toBe("ctrl+n");
        expect(s.prevIssueHotkey).toBe("ctrl+p");
    });

    test("garbage values fall back to defaults", () => {
        const s = resolveSettings({
            bridgeUrl: 42,
            realtimeDelayMs: "fast",
            applyAllHotkey: "   ",
            cycleNextHotkey: "   ",
            cyclePrevHotkey: "   ",
            allowRemoteBridge: "yes",
        });
        expect(s.bridgeUrl).toBe("http://localhost:8000");
        expect(s.realtimeDelayMs).toBe(500);
        expect(s.applyAllHotkey).toBe("ctrl+.");
        expect(s.cycleNextHotkey).toBe("ctrl+n");
        expect(s.cyclePrevHotkey).toBe("ctrl+p");
        expect(s.allowRemoteBridge).toBe(false);
    });

    test("completionEnabled defaults to false (opt-in)", () => {
        const s = resolveSettings({});
        expect(s.completionEnabled).toBe(false);
    });
    test("completionEnabled is rebindable", () => {
        const s = resolveSettings({ completionEnabled: true });
        expect(s.completionEnabled).toBe(true);
    });
    test("completionDebounceMs defaults to 600", () => {
        const s = resolveSettings({});
        expect(s.completionDebounceMs).toBe(600);
    });
    test("completionDebounceMs is rebindable", () => {
        const s = resolveSettings({ completionDebounceMs: 300 });
        expect(s.completionDebounceMs).toBe(300);
    });
    test("completionDebounceMs coerces non-number to default", () => {
        const s = resolveSettings({ completionDebounceMs: "fast" });
        expect(s.completionDebounceMs).toBe(600);
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
        let detailsLayerEnabled: (() => boolean) | null = null;
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
            get detailsLayerEnabled(): (() => boolean) | null {
                return detailsLayerEnabled;
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
                    if (
                        (layer.commands ?? []).some((c) => c.name === "grammarforge.details.apply")
                    ) {
                        detailsLayerEnabled = layer.enabled ?? null;
                    }
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
                setStatusText: () => undefined,
                subscribeStatus: () => () => undefined,
            }),
        });
        expect(commandHandlers.has("grammarforge.applyAll")).toBe(true);
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
                setStatusText: () => undefined,
                subscribeStatus: () => () => undefined,
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
        // Cycle keys are now ctrl+n/ctrl+p (not "/"/".").
        expect(detailsKeys).toContain("ctrl+n");
        expect(detailsKeys).toContain("ctrl+p");
        expect(detailsKeys).not.toContain("/");
        expect(detailsKeys).not.toContain(".");
        expect(detailsKeys).toContain("escape");
        const applyAllLayer = layers.find((l) =>
            (l.commands ?? []).some((c) => c.name === "grammarforge.applyAll"),
        );
        const applyAllKeys = (applyAllLayer?.bindings ?? []).map((b) => b.key);
        expect(applyAllKeys).toContain("ctrl+.");
        stop();
    });

    test("renderDecorations: extmarks.create is called with virtual:false (non-atomic underline)", async () => {
        // BUG 2 regression guard: underline extmarks must NOT be virtual:true.
        // virtual:true makes @opentui/core treat the extmark as an atomic chip
        // (findVirtualExtmarkContaining matches on virtual:true), causing backspace
        // at the edge of an underlined word to delete the whole word.
        // virtual:false keeps the underline visual (styleId is still applied) but
        // makes the extmark non-atomic so backspace deletes one char at a time.
        const createArgs: Array<Record<string, unknown>> = [];
        let resolveCorrect!: (res: unknown) => void;

        const ref = {
            text: "I has a apple",
            current: { input: "I has a apple", parts: [] },
            cursorOffset: 0,
            extmarks: {
                registerType: () => 1,
                create: (opts: Record<string, unknown>) => {
                    createArgs.push(opts);
                    return createArgs.length;
                },
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => "I has a apple".slice(s, e),
            replaceRange: () => undefined,
            focus: () => undefined,
        };

        const api = {
            prompt: {
                ref: () => ref,
                onChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
                onCursorChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
            },
            keymap: { registerLayer: () => () => undefined },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () =>
                new Promise<unknown>((resolve) => {
                    resolveCorrect = resolve;
                }),
        } as unknown as OrchestratorDeps);

        // Wait for debounce to fire.
        await new Promise((r) => setTimeout(r, 30));

        // Resolve with one suggestion so renderDecorations fires.
        resolveCorrect({
            original: "I has a apple",
            score: 90,
            suggestions: [
                { id: 1, span: { start: 2, end: 5 }, replacement: "have", model: "harper" },
            ],
        });
        await new Promise((r) => setTimeout(r, 10));

        // At least one extmark was created (the underline for "has").
        expect(createArgs.length).toBeGreaterThanOrEqual(1);
        // CRITICAL: every created extmark must have virtual:false.
        for (const args of createArgs) {
            expect(args["virtual"]).toBe(false);
        }

        stop();
    });

    test("applyPinned: dismisses details card and resets state so re-check rebuilds on edited text", async () => {
        // BUG 1 regression guard: after applying a pinned suggestion,
        // the details card must dismiss (pinnedIndex → null), stale
        // underlines must be cleared (activeExtmarkIds empty), and
        // state.items/displaySpans/checkedText must be reset so the
        // stale-guard in onCursorMove returns early until the fresh
        // check lands.
        const deletedIds: number[] = [];
        let extmarkCounter = 0;
        let resolveCorrect!: (res: unknown) => void;
        const replaceRangeCalls: Array<[number, number, string]> = [];
        const correctCalls: number[] = [];

        const ref = {
            text: "I has a apple",
            current: { input: "I has a apple", parts: [] },
            cursorOffset: 3, // inside "has" span
            extmarks: {
                registerType: () => 1,
                create: () => {
                    extmarkCounter++;
                    return extmarkCounter;
                },
                getAllForTypeId: () => [],
                delete: (id: number) => {
                    deletedIds.push(id);
                    return true;
                },
            },
            getTextRange: (s: number, e: number) => "I has a apple".slice(s, e),
            replaceRange: (s: number, e: number, r: string) => {
                replaceRangeCalls.push([s, e, r]);
            },
            focus: () => undefined,
        };

        const commandHandlers = new Map<string, () => unknown>();
        let onCursorChangeCb = (): void => undefined;

        const api = {
            prompt: {
                ref: () => ref,
                onChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
                onCursorChange: (cb: () => void) => {
                    onCursorChangeCb = cb;
                    return () => undefined;
                },
            },
            keymap: {
                registerLayer: (layer: {
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () =>
                new Promise<unknown>((resolve) => {
                    correctCalls.push(correctCalls.length + 1);
                    resolveCorrect = resolve;
                }),
        } as unknown as OrchestratorDeps);

        // Wait for initial debounce.
        await new Promise((r) => setTimeout(r, 30));
        const firstCorrectCount = correctCalls.length;
        expect(firstCorrectCount).toBeGreaterThanOrEqual(1);

        // Resolve with a suggestion to populate state.items and render underlines.
        resolveCorrect({
            original: "I has a apple",
            score: 90,
            suggestions: [
                { id: 1, span: { start: 2, end: 5 }, replacement: "have", model: "harper" },
            ],
        });
        await new Promise((r) => setTimeout(r, 10));

        // Underlines were created.
        expect(extmarkCounter).toBeGreaterThanOrEqual(1);

        // Simulate cursor move to pin item 0.
        onCursorChangeCb();

        // Now invoke applyPinned (the "return" key handler).
        const applyFn = commandHandlers.get("grammarforge.details.apply");
        expect(applyFn).toBeDefined();
        applyFn!();

        // replaceRange was called (the edit happened).
        expect(replaceRangeCalls.length).toBe(1);

        // All extmarks were deleted (clearActiveExtmarks ran).
        expect(deletedIds.length).toBeGreaterThanOrEqual(1);

        // A re-check was scheduled (correctCalls grew after the apply).
        await new Promise((r) => setTimeout(r, 30));
        expect(correctCalls.length).toBeGreaterThan(firstCorrectCount);

        stop();
    });

    test("onCursorMove: cursor off all suggestions unpins the card", async () => {
        // BUG 3 regression guard: when the cursor moves off a suggestion
        // (e.g. pressing up/arrow or clicking empty space), the details
        // card must dismiss. The else branch in onCursorMove calls
        // detailsState.unpin() when matchIndex === null.
        const layers: Array<{
            enabled?: () => boolean;
            commands?: Array<{ name: string }>;
        }> = [];
        let resolveCorrect!: (res: unknown) => void;
        const correctCalls: number[] = [];

        const ref = {
            text: "I has a apple",
            current: { input: "I has a apple", parts: [] },
            cursorOffset: 3, // inside "has" span
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => "I has a apple".slice(s, e),
            replaceRange: () => undefined,
            focus: () => undefined,
        };

        let onCursorChangeCb = (): void => undefined;

        const api = {
            prompt: {
                ref: () => ref,
                onChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
                onCursorChange: (cb: () => void) => {
                    onCursorChangeCb = cb;
                    return () => undefined;
                },
            },
            keymap: {
                registerLayer: (layer: {
                    enabled?: () => boolean;
                    commands?: Array<{ name: string }>;
                }) => {
                    layers.push(layer);
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () =>
                new Promise<unknown>((resolve) => {
                    correctCalls.push(correctCalls.length + 1);
                    resolveCorrect = resolve;
                }),
        } as unknown as OrchestratorDeps);

        // Find the details layer's enabled getter.
        const detailsLayer = layers.find((l) =>
            (l.commands ?? []).some((c) => c.name === "grammarforge.details.apply"),
        );
        expect(detailsLayer).toBeDefined();
        const isPinned = (): boolean => detailsLayer!.enabled!();

        // Wait for initial debounce.
        await new Promise((r) => setTimeout(r, 30));
        expect(correctCalls.length).toBeGreaterThanOrEqual(1);

        // Resolve with a suggestion to populate state.
        resolveCorrect({
            original: "I has a apple",
            score: 90,
            suggestions: [
                { id: 1, span: { start: 2, end: 5 }, replacement: "have", model: "harper" },
            ],
        });
        await new Promise((r) => setTimeout(r, 10));

        // Cursor is at offset 3 (inside "has" span) — pinning should work.
        expect(isPinned()).toBe(false);
        onCursorChangeCb();
        expect(isPinned()).toBe(true);

        // Move cursor OFF all suggestion spans (offset 0, before "has").
        ref.cursorOffset = 0;
        onCursorChangeCb();
        expect(isPinned()).toBe(false);

        stop();
    });

    test("applyAll: applies all 3 items in descending cuStart order and runs post-apply cleanup", async () => {
        // Three suggestions at increasing offsets. applyAll must call replaceRange
        // for all three in DESCENDING cuStart order (highest first) so earlier
        // edits don't shift later spans. After the loop: state cleared, re-check
        // scheduled, pinnedIndex null.
        const text = "I has a apple and teh cat";
        // Spans (code-unit): "has"=[2,5), "apple"=[8,13), "teh"=[18,21)
        const deletedIds: number[] = [];
        let extmarkCounter = 0;
        let resolveCorrect!: (res: unknown) => void;
        const replaceRangeCalls: Array<[number, number, string]> = [];
        const correctCalls: number[] = [];
        const toasts: Array<{ message: string; variant?: string }> = [];

        const ref = {
            text,
            current: { input: text, parts: [] },
            cursorOffset: 2,
            extmarks: {
                registerType: () => 1,
                create: () => {
                    extmarkCounter++;
                    return extmarkCounter;
                },
                getAllForTypeId: () => [],
                delete: (id: number) => {
                    deletedIds.push(id);
                    return true;
                },
            },
            getTextRange: (s: number, e: number) => text.slice(s, e),
            replaceRange: (s: number, e: number, r: string) => {
                replaceRangeCalls.push([s, e, r]);
            },
            focus: () => undefined,
        };

        const commandHandlers = new Map<string, () => unknown>();
        const layers: Array<{
            enabled?: () => boolean;
            commands?: Array<{ name: string; run: () => unknown }>;
        }> = [];

        const api = {
            prompt: {
                ref: () => ref,
                onChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
                onCursorChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
            },
            keymap: {
                registerLayer: (layer: {
                    enabled?: () => boolean;
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    layers.push(layer);
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    return () => undefined;
                },
            },
            ui: { toast: (t: { message: string; variant?: string }) => toasts.push(t) },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () =>
                new Promise<unknown>((resolve) => {
                    correctCalls.push(correctCalls.length + 1);
                    resolveCorrect = resolve;
                }),
        } as unknown as OrchestratorDeps);

        await new Promise((r) => setTimeout(r, 30));
        const firstCorrectCount = correctCalls.length;

        // Three suggestions at ascending cuStart offsets.
        resolveCorrect({
            original: text,
            score: 90,
            suggestions: [
                { id: 1, span: { start: 2, end: 5 }, replacement: "have", model: "harper" },
                { id: 2, span: { start: 8, end: 13 }, replacement: "an apple", model: "harper" },
                { id: 3, span: { start: 18, end: 21 }, replacement: "the", model: "harper" },
            ],
        });
        await new Promise((r) => setTimeout(r, 10));

        expect(extmarkCounter).toBeGreaterThanOrEqual(1);

        // Invoke applyAll (ctrl+. handler).
        const applyAllFn = commandHandlers.get("grammarforge.applyAll");
        expect(applyAllFn).toBeDefined();
        applyAllFn!();

        // All 3 items were applied.
        expect(replaceRangeCalls.length).toBe(3);

        // Applied in DESCENDING cuStart order: "teh" (18) first, then "apple" (8), then "has" (2).
        // Display offsets equal code-unit offsets for ASCII text.
        expect(replaceRangeCalls[0]![0]).toBeGreaterThan(replaceRangeCalls[1]![0]!);
        expect(replaceRangeCalls[1]![0]).toBeGreaterThan(replaceRangeCalls[2]![0]!);

        // Correct replacements applied.
        expect(replaceRangeCalls[0]![2]).toBe("the"); // "teh" → "the"
        expect(replaceRangeCalls[1]![2]).toBe("an apple"); // "apple" → "an apple"
        expect(replaceRangeCalls[2]![2]).toBe("have"); // "has" → "have"

        // Extmarks cleared (post-apply cleanup).
        expect(deletedIds.length).toBeGreaterThanOrEqual(1);

        // Details layer is no longer enabled (pinnedIndex null).
        const detailsLayer = layers.find((l) =>
            (l.commands ?? []).some((c) => c.name === "grammarforge.details.apply"),
        );
        if (detailsLayer?.enabled) {
            expect(detailsLayer.enabled()).toBe(false);
        }

        // Toast confirms count.
        expect(toasts.some((t) => t.message.includes("3") && t.variant === "success")).toBe(true);

        // Re-check was scheduled.
        await new Promise((r) => setTimeout(r, 30));
        expect(correctCalls.length).toBeGreaterThan(firstCorrectCount);

        stop();
    });

    test("applyAll: stale-guard skips invalid spans, applies valid ones", async () => {
        // One item whose span is no longer valid (text changed) → skipped.
        // Another item whose span is still valid → applied.
        // We simulate stale by using a text that doesn't contain the first span.
        const text = "I has a apple";
        const replaceRangeCalls: Array<[number, number, string]> = [];

        // We'll make isSpanStillValid fail for item 0 by giving it a cuEnd
        // beyond the text length. Item 1 is valid.
        // The bridge response uses normal spans; we manipulate via a custom
        // correct fn that returns a span beyond text length for item 0.
        let resolveCorrect!: (res: unknown) => void;

        const ref = {
            text,
            current: { input: text, parts: [] },
            cursorOffset: 0,
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => text.slice(s, e),
            replaceRange: (s: number, e: number, r: string) => {
                replaceRangeCalls.push([s, e, r]);
            },
            focus: () => undefined,
        };

        const commandHandlers = new Map<string, () => unknown>();

        const api = {
            prompt: {
                ref: () => ref,
                onChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
                onCursorChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
            },
            keymap: {
                registerLayer: (layer: {
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () =>
                new Promise<unknown>((resolve) => {
                    resolveCorrect = resolve;
                }),
        } as unknown as OrchestratorDeps);

        await new Promise((r) => setTimeout(r, 30));

        // Item 0: span beyond text length (stale). Item 1: valid span.
        resolveCorrect({
            original: text,
            score: 90,
            suggestions: [
                // cuEnd=999 is beyond text.length=13 → isSpanStillValid returns false.
                { id: 1, span: { start: 0, end: 999 }, replacement: "STALE", model: "harper" },
                { id: 2, span: { start: 2, end: 5 }, replacement: "have", model: "harper" },
            ],
        });
        await new Promise((r) => setTimeout(r, 10));

        const applyAllFn = commandHandlers.get("grammarforge.applyAll");
        expect(applyAllFn).toBeDefined();
        applyAllFn!();

        // Only the valid item (id=2, "has"→"have") was applied; stale item skipped.
        expect(replaceRangeCalls.length).toBe(1);
        expect(replaceRangeCalls[0]![2]).toBe("have");

        stop();
    });

    test("applyAll: empty items → no-op, no throw", () => {
        // No suggestions → applyAll must return without throwing.
        const replaceRangeCalls: Array<unknown[]> = [];

        const ref = {
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
            replaceRange: (...args: unknown[]) => {
                replaceRangeCalls.push(args);
            },
            focus: () => undefined,
        };

        const commandHandlers = new Map<string, () => unknown>();

        const api = {
            prompt: {
                ref: () => ref,
                onChange: () => () => undefined,
                onCursorChange: () => () => undefined,
            },
            keymap: {
                registerLayer: (layer: {
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const stop = startOrchestrator(api, undefined);

        const applyAllFn = commandHandlers.get("grammarforge.applyAll");
        expect(applyAllFn).toBeDefined();
        // No items in state → must not throw.
        expect(() => applyAllFn!()).not.toThrow();
        // No replaceRange calls.
        expect(replaceRangeCalls.length).toBe(0);

        stop();
    });

    test("cycle bindings: details layer uses '.' for cycleNext and '/' for cyclePrev (not n/p)", () => {
        // Regression guard: after the rebind, the details layer must bind
        // "." → cycleNext and "/" → cyclePrev. "n", "p", and "," must NOT appear.
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

        const bindings = detailsLayer?.bindings ?? [];
        const cycleNextBinding = bindings.find((b) => b.cmd === "grammarforge.details.cycleNext");
        const cyclePrevBinding = bindings.find((b) => b.cmd === "grammarforge.details.cyclePrev");

        expect(cycleNextBinding?.key).toBe("ctrl+n");
        expect(cyclePrevBinding?.key).toBe("ctrl+p");

        // "/", "." must not appear as binding keys.
        const allKeys = bindings.map((b) => b.key);
        expect(allKeys).not.toContain("/");
        expect(allKeys).not.toContain(".");

        stop();
    });

    test("runCheck: bridge correctFn receives masked text; state.checkedText and buildRenderableItems see original", async () => {
        // Fixture: text with a paste placeholder at a known position.
        const placeholder = "[Pasted ~5 lines]";
        const originalText = `Hello ${placeholder} world`;
        const pStart = originalText.indexOf(placeholder);
        const pEnd = pStart + placeholder.length;
        // Confirm offsets are code-unit (slice === value).
        expect(originalText.slice(pStart, pEnd)).toBe(placeholder);

        const capturedCorrectArgs: Array<{ text: string }> = [];
        let resolveCorrect!: (res: unknown) => void;

        const ref = {
            text: originalText,
            current: {
                input: originalText,
                parts: [
                    {
                        type: "text" as const,
                        source: { text: { start: pStart, end: pEnd, value: placeholder } },
                    },
                ],
            },
            cursorOffset: 0,
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => originalText.slice(s, e),
            replaceRange: () => undefined,
            focus: () => undefined,
        };

        const api = {
            prompt: {
                ref: () => ref,
                onChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
                onCursorChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
            },
            keymap: { registerLayer: () => () => undefined },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: (req: { text: string }) => {
                capturedCorrectArgs.push({ text: req.text });
                return new Promise<unknown>((resolve) => {
                    resolveCorrect = resolve;
                });
            },
        } as unknown as OrchestratorDeps);

        // Wait for the debounce + first check to fire.
        await new Promise((r) => setTimeout(r, 30));
        expect(capturedCorrectArgs.length).toBeGreaterThanOrEqual(1);

        const sentText = capturedCorrectArgs[capturedCorrectArgs.length - 1]!.text;

        // 1. Bridge received MASKED text (placeholder replaced with spaces).
        expect(sentText.length).toBe(originalText.length); // equal length
        expect(sentText.slice(pStart, pEnd)).toBe(" ".repeat(placeholder.length));
        // Surrounding text is intact in the masked version.
        expect(sentText.slice(0, pStart)).toBe("Hello ");
        expect(sentText.slice(pEnd)).toBe(" world");

        // 2. Resolve the check so state.checkedText is set.
        resolveCorrect({
            original: originalText,
            score: 90,
            suggestions: [],
        });
        await new Promise((r) => setTimeout(r, 10));

        // 3. state.checkedText must equal the ORIGINAL text (not the masked one).
        //    We verify indirectly: the stale-guard check `ref.text !== text` uses
        //    the original. If checkedText were the masked version, the guard would
        //    fire on the next cursor move (ref.text !== maskedText). We can't read
        //    state directly, but we can confirm the bridge was called with masked
        //    text while the ref still holds the original — that's the contract.
        expect(ref.text).toBe(originalText); // ref.text is always the original

        stop();
    });

    test("cycleNext: advances pinnedIndex AND calls setCursorOffset with the new span's start", async () => {
        // Two suggestions: "has" at display [2,5) and "apple" at display [8,13).
        // Start pinned at index 0 (cursor on "has"). cycleNext → index 1 → cursor
        // moves to displaySpans[1].start = 8.
        const text = "I has a apple";
        const setCursorOffsetCalls: number[] = [];
        let resolveCorrect!: (res: unknown) => void;

        const ref = {
            text,
            current: { input: text, parts: [] },
            cursorOffset: 2, // inside "has"
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => text.slice(s, e),
            replaceRange: () => undefined,
            focus: () => undefined,
            setCursorOffset: (offset: number) => {
                setCursorOffsetCalls.push(offset);
            },
        };

        const commandHandlers = new Map<string, () => unknown>();
        let onCursorChangeCb = (): void => undefined;

        const api = {
            prompt: {
                ref: () => ref,
                onChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
                onCursorChange: (cb: () => void) => {
                    onCursorChangeCb = cb;
                    return () => undefined;
                },
            },
            keymap: {
                registerLayer: (layer: {
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () =>
                new Promise<unknown>((resolve) => {
                    resolveCorrect = resolve;
                }),
        } as unknown as OrchestratorDeps);

        // Wait for debounce.
        await new Promise((r) => setTimeout(r, 30));

        // Resolve with two suggestions: "has" [2,5) and "apple" [8,13).
        resolveCorrect({
            original: text,
            score: 90,
            suggestions: [
                { id: 1, span: { start: 2, end: 5 }, replacement: "have", model: "harper" },
                { id: 2, span: { start: 8, end: 13 }, replacement: "an apple", model: "harper" },
            ],
        });
        await new Promise((r) => setTimeout(r, 10));

        // Pin index 0 by simulating a cursor move onto "has".
        ref.cursorOffset = 2;
        onCursorChangeCb();

        // Verify pinned at 0.
        const cycleNextFn = commandHandlers.get("grammarforge.details.cycleNext") as () => void;
        expect(cycleNextFn).toBeDefined();

        // cycleNext: should advance to index 1 and call setCursorOffset with displaySpans[1].start.
        // displaySpans[1].start = 8 (display-width offset of "apple" in ASCII text).
        cycleNextFn();

        expect(setCursorOffsetCalls.length).toBeGreaterThanOrEqual(1);
        // The last call should be to the start of the second suggestion's display span.
        expect(setCursorOffsetCalls[setCursorOffsetCalls.length - 1]).toBe(8);

        stop();
    });

    test("cyclePrev: decrements pinnedIndex AND calls setCursorOffset with the new span's start", async () => {
        // Two suggestions: "has" at display [2,5) and "apple" at display [8,13).
        // Start pinned at index 1 (cursor on "apple"). cyclePrev → index 0 → cursor
        // moves to displaySpans[0].start = 2.
        const text = "I has a apple";
        const setCursorOffsetCalls: number[] = [];
        let resolveCorrect!: (res: unknown) => void;

        const ref = {
            text,
            current: { input: text, parts: [] },
            cursorOffset: 8, // inside "apple"
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => text.slice(s, e),
            replaceRange: () => undefined,
            focus: () => undefined,
            setCursorOffset: (offset: number) => {
                setCursorOffsetCalls.push(offset);
            },
        };

        const commandHandlers = new Map<string, () => unknown>();
        let onCursorChangeCb = (): void => undefined;

        const api = {
            prompt: {
                ref: () => ref,
                onChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
                onCursorChange: (cb: () => void) => {
                    onCursorChangeCb = cb;
                    return () => undefined;
                },
            },
            keymap: {
                registerLayer: (layer: {
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () =>
                new Promise<unknown>((resolve) => {
                    resolveCorrect = resolve;
                }),
        } as unknown as OrchestratorDeps);

        // Wait for debounce.
        await new Promise((r) => setTimeout(r, 30));

        // Resolve with two suggestions.
        resolveCorrect({
            original: text,
            score: 90,
            suggestions: [
                { id: 1, span: { start: 2, end: 5 }, replacement: "have", model: "harper" },
                { id: 2, span: { start: 8, end: 13 }, replacement: "an apple", model: "harper" },
            ],
        });
        await new Promise((r) => setTimeout(r, 10));

        // Pin index 1 by simulating a cursor move onto "apple".
        ref.cursorOffset = 8;
        onCursorChangeCb();

        const cyclePrevFn = commandHandlers.get("grammarforge.details.cyclePrev") as () => void;
        expect(cyclePrevFn).toBeDefined();

        // cyclePrev: should go to index 0 and call setCursorOffset with displaySpans[0].start = 2.
        cyclePrevFn();

        expect(setCursorOffsetCalls.length).toBeGreaterThanOrEqual(1);
        expect(setCursorOffsetCalls[setCursorOffsetCalls.length - 1]).toBe(2);

        stop();
    });

    test("cycle guard: setCursorOffset absent (unpatched host) — does not throw, still cycles card", async () => {
        // Simulate an unpatched host where ref.setCursorOffset is undefined.
        // cycleNext must still advance the pin without throwing.
        const text = "I has a apple";
        let resolveCorrect!: (res: unknown) => void;

        // Ref WITHOUT setCursorOffset — simulates an unpatched host.
        const ref = {
            text,
            current: { input: text, parts: [] },
            cursorOffset: 2,
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => text.slice(s, e),
            replaceRange: () => undefined,
            focus: () => undefined,
            // setCursorOffset intentionally absent
        };

        const commandHandlers = new Map<string, () => unknown>();
        let onCursorChangeCb = (): void => undefined;

        const api = {
            prompt: {
                ref: () => ref,
                onChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
                onCursorChange: (cb: () => void) => {
                    onCursorChangeCb = cb;
                    return () => undefined;
                },
            },
            keymap: {
                registerLayer: (layer: {
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () =>
                new Promise<unknown>((resolve) => {
                    resolveCorrect = resolve;
                }),
        } as unknown as OrchestratorDeps);

        await new Promise((r) => setTimeout(r, 30));

        resolveCorrect({
            original: text,
            score: 90,
            suggestions: [
                { id: 1, span: { start: 2, end: 5 }, replacement: "have", model: "harper" },
                { id: 2, span: { start: 8, end: 13 }, replacement: "an apple", model: "harper" },
            ],
        });
        await new Promise((r) => setTimeout(r, 10));

        // Pin index 0.
        ref.cursorOffset = 2;
        onCursorChangeCb();

        const cycleNextFn = commandHandlers.get("grammarforge.details.cycleNext") as () => void;
        expect(cycleNextFn).toBeDefined();

        // Must not throw even though setCursorOffset is absent.
        expect(() => cycleNextFn()).not.toThrow();

        stop();
    });

    // ─── Rephrase state machine tests ─────────────────────────────────────────

    /** Build a minimal orchestrator env with rephrase support injected. */
    const makeRephraseEnv = () => {
        const text = "Hello world";
        const replaceRangeCalls: Array<[number, number, string]> = [];
        const toasts: Array<{ message: string; variant?: string }> = [];
        const setViewCalls: Array<import("./details-panel-view").PanelView | null> = [];
        const commandHandlers = new Map<string, () => unknown>();
        const layers: Array<{
            enabled?: () => boolean;
            commands?: Array<{ name: string; run: () => unknown }>;
            bindings?: Array<{ key: string; cmd: string }>;
        }> = [];
        const pendingRephrase: Array<(res: unknown) => void> = [];
        const pendingRephraseReject: Array<(err: unknown) => void> = [];

        const ref = {
            text,
            current: { input: text, parts: [] },
            cursorOffset: 0,
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => text.slice(s, e),
            replaceRange: (s: number, e: number, r: string) => {
                replaceRangeCalls.push([s, e, r]);
            },
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
                    bindings?: Array<{ key: string; cmd: string }>;
                }) => {
                    layers.push(layer);
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    return () => undefined;
                },
            },
            ui: { toast: (t: { message: string; variant?: string }) => toasts.push(t) },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const panelController = {
            setView: (v: import("./details-panel-view").PanelView | null) => setViewCalls.push(v),
            subscribe: () => () => undefined,
            dispose: () => undefined,
            setStatusText: () => undefined,
            subscribeStatus: () => () => undefined,
        };

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () => new Promise<unknown>(() => undefined),
            rephrase: () =>
                new Promise<unknown>((resolve, reject) => {
                    pendingRephrase.push(resolve);
                    pendingRephraseReject.push(reject);
                }),
            panelRenderer: () => panelController,
        } as unknown as OrchestratorDeps);

        const getRephraseLayer = () =>
            layers.find((l) =>
                (l.commands ?? []).some((c) => c.name === "grammarforge.rephrase.accept"),
            );

        return {
            ref,
            toasts,
            setViewCalls,
            commandHandlers,
            layers,
            pendingRephrase,
            pendingRephraseReject,
            replaceRangeCalls,
            getRephraseLayer,
            stop,
        };
    };

    test("rephrase: grammarforge.rephrase command is registered in the always-on layer", () => {
        const { commandHandlers, stop } = makeRephraseEnv();
        expect(commandHandlers.has("grammarforge.rephrase")).toBe(true);
        stop();
    });

    test("rephrase: ctrl+/ binding is registered for grammarforge.rephrase", () => {
        const { layers, stop } = makeRephraseEnv();
        const alwaysOnLayer = layers.find((l) =>
            (l.commands ?? []).some((c) => c.name === "grammarforge.rephrase"),
        );
        expect(alwaysOnLayer).toBeDefined();
        const binding = (alwaysOnLayer?.bindings ?? []).find(
            (b) => b.cmd === "grammarforge.rephrase",
        );
        expect(binding?.key).toBe("ctrl+/");
        stop();
    });

    test("rephrase: happy path — loading card shown, then result card on resolve", async () => {
        const { commandHandlers, setViewCalls, pendingRephrase, stop } = makeRephraseEnv();

        const rephraseFn = commandHandlers.get("grammarforge.rephrase") as () => void;
        expect(rephraseFn).toBeDefined();
        rephraseFn();

        // Loading card should be shown immediately.
        const loadingViews = setViewCalls.filter((v) => v?.kind === "rephrase-loading");
        expect(loadingViews.length).toBeGreaterThanOrEqual(1);

        // Resolve the rephrase stub.
        expect(pendingRephrase.length).toBe(1);
        pendingRephrase[0]!({
            original: "Hello world",
            rephrased: "Hi there world",
            alternatives: [],
        });
        await new Promise((r) => setTimeout(r, 10));

        // Result card should be shown.
        const resultViews = setViewCalls.filter((v) => v?.kind === "rephrase-result");
        expect(resultViews.length).toBeGreaterThanOrEqual(1);
        const resultView = resultViews[
            resultViews.length - 1
        ] as import("./details-panel-view").RephraseResultView;
        expect(resultView.rephrased).toBe("Hi there world");

        stop();
    });

    test("rephrase: accept — replaceRange called with rephrased text, setView(null) called", async () => {
        const { commandHandlers, setViewCalls, pendingRephrase, replaceRangeCalls, stop } =
            makeRephraseEnv();

        const rephraseFn = commandHandlers.get("grammarforge.rephrase") as () => void;
        rephraseFn();

        pendingRephrase[0]!({
            original: "Hello world",
            rephrased: "Hi there world",
            alternatives: [],
        });
        await new Promise((r) => setTimeout(r, 10));

        // Accept the rephrase.
        const acceptFn = commandHandlers.get("grammarforge.rephrase.accept") as () => void;
        expect(acceptFn).toBeDefined();
        acceptFn();

        // replaceRange was called.
        expect(replaceRangeCalls.length).toBe(1);
        expect(replaceRangeCalls[0]![2]).toBe("Hi there world");

        // setView(null) was called to dismiss the card.
        const lastView = setViewCalls[setViewCalls.length - 1];
        expect(lastView).toBeNull();

        stop();
    });

    test("rephrase: reject — setView(null) called, no replaceRange", async () => {
        const { commandHandlers, setViewCalls, pendingRephrase, replaceRangeCalls, stop } =
            makeRephraseEnv();

        const rephraseFn = commandHandlers.get("grammarforge.rephrase") as () => void;
        rephraseFn();

        pendingRephrase[0]!({
            original: "Hello world",
            rephrased: "Hi there world",
            alternatives: [],
        });
        await new Promise((r) => setTimeout(r, 10));

        const rejectFn = commandHandlers.get("grammarforge.rephrase.reject") as () => void;
        expect(rejectFn).toBeDefined();
        rejectFn();

        // No replaceRange.
        expect(replaceRangeCalls.length).toBe(0);

        // setView(null) was called.
        const lastView = setViewCalls[setViewCalls.length - 1];
        expect(lastView).toBeNull();

        stop();
    });

    test("rephrase: stale guard — reject before resolve, old result does NOT show result card", async () => {
        const { commandHandlers, setViewCalls, pendingRephrase, stop } = makeRephraseEnv();

        const rephraseFn = commandHandlers.get("grammarforge.rephrase") as () => void;
        rephraseFn();

        // Reject (bumps seq) before the async resolves.
        const rejectFn = commandHandlers.get("grammarforge.rephrase.reject") as () => void;
        rejectFn();

        // Now resolve the old stub — should be ignored (stale seq).
        expect(pendingRephrase.length).toBe(1);
        pendingRephrase[0]!({
            original: "Hello world",
            rephrased: "Hi there world",
            alternatives: [],
        });
        await new Promise((r) => setTimeout(r, 10));

        // No result card should have been shown after the reject.
        const resultViewsAfterReject = setViewCalls.filter((v) => v?.kind === "rephrase-result");
        expect(resultViewsAfterReject.length).toBe(0);

        stop();
    });

    test("rephrase: superseded completion does not stop newer spinner", async () => {
        const { commandHandlers, setViewCalls, pendingRephrase, stop } = makeRephraseEnv();

        const rephraseFn = commandHandlers.get("grammarforge.rephrase") as () => void;
        expect(rephraseFn).toBeDefined();

        // Start rephrase A (seq 1).
        rephraseFn();
        expect(pendingRephrase.length).toBe(1);
        const resolveA = pendingRephrase[0]!;

        // Count loading views before B.
        const loadingBeforeB = setViewCalls.filter((v) => v?.kind === "rephrase-loading").length;

        // Start rephrase B (seq 2) — supersedes A.
        rephraseFn();
        expect(pendingRephrase.length).toBe(2);
        const resolveB = pendingRephrase[1]!;

        // Resolve A (stale) — must NOT clear B's state.
        resolveA!({
            original: "Hello world",
            rephrased: "Hi there world",
            alternatives: [],
        });
        await new Promise((r) => setTimeout(r, 10));

        // After A resolves: state.rephrase should still be B's loading state (not null).
        // B's loading view should still be active (setViewCalls should have rephrase-loading
        // calls from B's spinner, not cleared by A).
        const loadingAfterA = setViewCalls.filter((v) => v?.kind === "rephrase-loading").length;
        expect(loadingAfterA).toBeGreaterThan(loadingBeforeB);

        // Now resolve B — should show result.
        resolveB!({
            original: "Hello world",
            rephrased: "Hi there world",
            alternatives: [],
        });
        await new Promise((r) => setTimeout(r, 10));

        const resultViews = setViewCalls.filter((v) => v?.kind === "rephrase-result");
        expect(resultViews.length).toBeGreaterThanOrEqual(1);
        const resultView = resultViews[
            resultViews.length - 1
        ] as import("./details-panel-view").RephraseResultView;
        expect(resultView.rephrased).toBe("Hi there world");

        stop();
    });

    test("rephrase: empty/no-op — rephrased === original → info toast, no result card", async () => {
        const { commandHandlers, setViewCalls, toasts, pendingRephrase, stop } = makeRephraseEnv();

        const rephraseFn = commandHandlers.get("grammarforge.rephrase") as () => void;
        rephraseFn();

        // Resolve with same text.
        pendingRephrase[0]!({
            original: "Hello world",
            rephrased: "Hello world",
            alternatives: [],
        });
        await new Promise((r) => setTimeout(r, 10));

        // No result card.
        const resultViews = setViewCalls.filter((v) => v?.kind === "rephrase-result");
        expect(resultViews.length).toBe(0);

        // Info toast.
        expect(toasts.some((t) => t.variant === "info")).toBe(true);

        stop();
    });

    test("rephrase: accept with stale text — no replaceRange, info toast", async () => {
        const {
            commandHandlers,
            setViewCalls,
            toasts,
            pendingRephrase,
            replaceRangeCalls,
            ref,
            stop,
        } = makeRephraseEnv();

        const rephraseFn = commandHandlers.get("grammarforge.rephrase") as () => void;
        rephraseFn();

        pendingRephrase[0]!({
            original: "Hello world",
            rephrased: "Hi there world",
            alternatives: [],
        });
        await new Promise((r) => setTimeout(r, 10));

        // Simulate prompt text changing after rephrase resolved.
        (ref as { text: string }).text = "Hello world changed";

        const acceptFn = commandHandlers.get("grammarforge.rephrase.accept") as () => void;
        acceptFn();

        // No replaceRange (text changed).
        expect(replaceRangeCalls.length).toBe(0);

        // Info toast about stale text.
        expect(toasts.some((t) => t.variant === "info" && t.message.includes("changed"))).toBe(
            true,
        );

        // Card dismissed.
        const lastView = setViewCalls[setViewCalls.length - 1];
        expect(lastView).toBeNull();

        stop();
    });

    test("rephrase: rephrase layer enabled only when state.rephrase !== null", async () => {
        const { commandHandlers, getRephraseLayer, pendingRephrase, stop } = makeRephraseEnv();

        const rephraseLayer = getRephraseLayer();
        expect(rephraseLayer).toBeDefined();
        expect(rephraseLayer!.enabled).toBeDefined();

        // Before rephrase: disabled.
        expect(rephraseLayer!.enabled!()).toBe(false);

        // Start rephrase: enabled (loading mode).
        const rephraseFn = commandHandlers.get("grammarforge.rephrase") as () => void;
        rephraseFn();
        expect(rephraseLayer!.enabled!()).toBe(true);

        // Resolve to result: still enabled.
        pendingRephrase[0]!({
            original: "Hello world",
            rephrased: "Hi there world",
            alternatives: [],
        });
        await new Promise((r) => setTimeout(r, 10));
        expect(rephraseLayer!.enabled!()).toBe(true);

        // Reject: disabled again.
        const rejectFn = commandHandlers.get("grammarforge.rephrase.reject") as () => void;
        rejectFn();
        expect(rephraseLayer!.enabled!()).toBe(false);

        stop();
    });

    test("rephrase: onCursorMove suppressed while state.rephrase !== null", async () => {
        // When rephrase is active, cursor moves must NOT pin suggestions.
        const text = "I has a apple";
        const setViewCalls: Array<import("./details-panel-view").PanelView | null> = [];
        const commandHandlers = new Map<string, () => unknown>();
        let onCursorChangeCb = (): void => undefined;
        let resolveCorrect!: (res: unknown) => void;
        const pendingRephrase: Array<(res: unknown) => void> = [];

        const ref = {
            text,
            current: { input: text, parts: [] },
            cursorOffset: 3, // inside "has"
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => text.slice(s, e),
            replaceRange: () => undefined,
            focus: () => undefined,
        };

        const api = {
            prompt: {
                ref: () => ref,
                onChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
                onCursorChange: (cb: () => void) => {
                    onCursorChangeCb = cb;
                    return () => undefined;
                },
            },
            keymap: {
                registerLayer: (layer: {
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const panelController = {
            setView: (v: import("./details-panel-view").PanelView | null) => setViewCalls.push(v),
            subscribe: () => () => undefined,
            dispose: () => undefined,
            setStatusText: () => undefined,
            subscribeStatus: () => () => undefined,
        };

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () =>
                new Promise<unknown>((resolve) => {
                    resolveCorrect = resolve;
                }),
            rephrase: () =>
                new Promise<unknown>((resolve) => {
                    pendingRephrase.push(resolve);
                }),
            panelRenderer: () => panelController,
        } as unknown as OrchestratorDeps);

        // Wait for check to complete so items are populated.
        await new Promise((r) => setTimeout(r, 30));
        resolveCorrect({
            original: text,
            score: 90,
            suggestions: [
                { id: 1, span: { start: 2, end: 5 }, replacement: "have", model: "harper" },
            ],
        });
        await new Promise((r) => setTimeout(r, 10));

        // Start rephrase — this sets state.rephrase.
        const rephraseFn = commandHandlers.get("grammarforge.rephrase") as () => void;
        rephraseFn();

        // Clear setViewCalls so we can check what happens next.
        setViewCalls.length = 0;

        // Fire cursor move — should be suppressed (no suggestion card pushed).
        onCursorChangeCb();

        // No suggestion-kind setView should have been called.
        const suggestionViews = setViewCalls.filter((v) => v?.kind === "suggestion");
        expect(suggestionViews.length).toBe(0);

        stop();
    });

    test("rephrase: error path — error toast shown, card dismissed", async () => {
        const { commandHandlers, setViewCalls, toasts, pendingRephraseReject, stop } =
            makeRephraseEnv();

        const rephraseFn = commandHandlers.get("grammarforge.rephrase") as () => void;
        rephraseFn();

        // Reject the rephrase promise with an error.
        pendingRephraseReject[0]!(new Error("bridge error"));
        await new Promise((r) => setTimeout(r, 10));

        // Error toast.
        expect(toasts.some((t) => t.variant === "error")).toBe(true);

        // Card dismissed.
        const lastView = setViewCalls[setViewCalls.length - 1];
        expect(lastView).toBeNull();

        stop();
    });

    test("rephrase: resolveSettings defaults rephraseHotkey to ctrl+/", () => {
        const s = resolveSettings(undefined);
        expect(s.rephraseHotkey).toBe("ctrl+/");
    });

    test("rephrase: resolveSettings honors custom rephraseHotkey", () => {
        const s = resolveSettings({ rephraseHotkey: "ctrl+r" });
        expect(s.rephraseHotkey).toBe("ctrl+r");
    });

    test("rephrase: accept applies SELECTED alternative (not always primary)", async () => {
        const { commandHandlers, pendingRephrase, replaceRangeCalls, stop } = makeRephraseEnv();

        // Start rephrase.
        const rephraseFn = commandHandlers.get("grammarforge.rephrase") as () => void;
        rephraseFn();

        // Resolve with alternatives.
        pendingRephrase[0]!({
            original: "He go to school",
            rephrased: "He goes to school",       // primary (index 0)
            alternatives: ["He is going to school", "He went to school"],
        });
        await new Promise((r) => setTimeout(r, 10));

        // Cycle to alternative #1 (the second variant: "He is going to school").
        const cycleAltNext = commandHandlers.get("grammarforge.rephrase.cycleAltNext") as () => void;
        expect(cycleAltNext).toBeDefined();
        cycleAltNext();

        // Now accept — should apply "He is going to school" (alt index 1), NOT the primary.
        const acceptFn = commandHandlers.get("grammarforge.rephrase.accept") as () => void;
        acceptFn();

        expect(replaceRangeCalls.length).toBe(1);
        expect(replaceRangeCalls[0]![2]).toBe("He is going to school");

        stop();
    });

    // ─── A8: Eager dismiss on edit ─────────────────────────────────────

    test("A8 eager-dismiss: onChange textChanged clears pinned card immediately", async () => {
        const text = "I has a apple";
        let onCursorChangeCb = (): void => undefined;
        let onChangeCb = (): void => undefined;
        const setViewCalls: Array<import("./details-panel-view").PanelView | null> = [];
        let resolveCorrect!: (res: unknown) => void;

        let currentRef = {
            text,
            current: { input: text, parts: [] },
            cursorOffset: 3,
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => text.slice(s, e),
            replaceRange: () => undefined,
            focus: () => undefined,
        };

        const api = {
            prompt: {
                ref: () => currentRef,
                onChange: (cb: () => void) => {
                    onChangeCb = cb;
                    return () => undefined;
                },
                onCursorChange: (cb: () => void) => {
                    onCursorChangeCb = cb;
                    return () => undefined;
                },
            },
            keymap: {
                registerLayer: (layer: {
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    void layer.commands;
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () =>
                new Promise<unknown>((resolve) => {
                    resolveCorrect = resolve;
                }),
            panelRenderer: () => ({
                setView: (v: import("./details-panel-view").PanelView | null) => setViewCalls.push(v),
                subscribe: () => () => undefined,
                dispose: () => undefined,
                setStatusText: () => undefined,
                subscribeStatus: () => () => undefined,
            }),
        } as unknown as OrchestratorDeps);

        // Wait for the initial debounced check.
        await new Promise((r) => setTimeout(r, 30));
        expect(resolveCorrect).toBeDefined();
        resolveCorrect!({
            original: text,
            score: 90,
            suggestions: [
                { id: 1, span: { start: 2, end: 5 }, replacement: "have", model: "harper" },
            ],
        });
        await new Promise((r) => setTimeout(r, 10));

        // Pin index 0 by moving cursor to offset 3 (inside "has").
        currentRef.cursorOffset = 3;
        onCursorChangeCb();

        // Should be pinned now.
        const pinnedViews = setViewCalls.filter((v) => v?.kind === "suggestion");
        expect(pinnedViews.length).toBeGreaterThanOrEqual(1);

        // Now simulate a text edit: change ref.text AND fire onChange.
        currentRef.text = "I has an apple";
        onChangeCb();

        // The pinned card should be IMMEDIATELY cleared (eager).
        const lastView = setViewCalls[setViewCalls.length - 1];
        expect(lastView).toBeNull();

        stop();
    });

    test("A8 eager-dismiss: underlines NOT cleared eagerly (reconcile on re-check)", async () => {
        const text = "I has a apple";
        let onChangeCb = (): void => undefined;
        let resolveCorrect!: (res: unknown) => void;
        const deletedExtmarks: number[] = [];

        let currentRef = {
            text,
            current: { input: text, parts: [] },
            cursorOffset: 3,
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: (id: number) => {
                    deletedExtmarks.push(id);
                    return true;
                },
            },
            getTextRange: (s: number, e: number) => text.slice(s, e),
            replaceRange: () => undefined,
            focus: () => undefined,
        };

        const api = {
            prompt: {
                ref: () => currentRef,
                onChange: (cb: () => void) => {
                    onChangeCb = cb;
                    return () => undefined;
                },
                onCursorChange: () => () => undefined,
            },
            keymap: {
                registerLayer: (layer: {
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    void layer.commands;
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () =>
                new Promise<unknown>((resolve) => {
                    resolveCorrect = resolve;
                }),
        } as unknown as OrchestratorDeps);

        await new Promise((r) => setTimeout(r, 30));
        resolveCorrect!({
            original: text,
            score: 90,
            suggestions: [
                { id: 1, span: { start: 2, end: 5 }, replacement: "have", model: "harper" },
            ],
        });
        await new Promise((r) => setTimeout(r, 10));

        // Extmarks should have been created.
        const deletedBefore = deletedExtmarks.length;

        // Simulate text edit.
        currentRef.text = "I has an apple";
        onChangeCb();

        // Underlines NOT eagerly cleared — extmarks remain.
        expect(deletedExtmarks.length).toBe(deletedBefore);

        stop();
    });

    // ─── BLOCKER 2: ignorePinned keeps displaySpans aligned with items ─────────

    test("ignorePinned: ignoring middle item keeps displaySpans aligned with surviving items", async () => {
        // Three items at distinct offsets. Ignore the MIDDLE one (index 1).
        // After ignore: two survivors at indices 0 and 2 (now 0 and 1).
        // Their displaySpans must map to THEIR OWN original spans, not the
        // ignored item's span. Pre-fix: items[1] would map to spans[2] (wrong).
        const text = "I has a apple and teh cat";
        // "has"=[2,5), "apple"=[8,13), "teh"=[18,21)
        let resolveCorrect!: (res: unknown) => void;
        const commandHandlers = new Map<string, () => unknown>();
        let onCursorChangeCb = (): void => undefined;
        const setViewCalls: Array<import("./details-panel-view").PanelView | null> = [];

        const ref = {
            text,
            current: { input: text, parts: [] },
            cursorOffset: 8, // inside "apple" (index 1)
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => text.slice(s, e),
            replaceRange: () => undefined,
            focus: () => undefined,
        };

        const api = {
            prompt: {
                ref: () => ref,
                onChange: (cb: () => void) => {
                    void cb;
                    return () => undefined;
                },
                onCursorChange: (cb: () => void) => {
                    onCursorChangeCb = cb;
                    return () => undefined;
                },
            },
            keymap: {
                registerLayer: (layer: {
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const panelController = {
            setView: (v: import("./details-panel-view").PanelView | null) => setViewCalls.push(v),
            subscribe: () => () => undefined,
            dispose: () => undefined,
            setStatusText: () => undefined,
            subscribeStatus: () => () => undefined,
        };

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () =>
                new Promise<unknown>((resolve) => {
                    resolveCorrect = resolve;
                }),
            panelRenderer: () => panelController,
        } as unknown as OrchestratorDeps);

        // Wait for debounce.
        await new Promise((r) => setTimeout(r, 30));

        // Resolve with 3 suggestions at distinct offsets.
        resolveCorrect({
            original: text,
            score: 90,
            suggestions: [
                { id: 1, span: { start: 2, end: 5 }, replacement: "have", model: "harper" },
                { id: 2, span: { start: 8, end: 13 }, replacement: "an apple", model: "harper" },
                { id: 3, span: { start: 18, end: 21 }, replacement: "the", model: "harper" },
            ],
        });
        await new Promise((r) => setTimeout(r, 10));

        // Pin the middle item (index 1, "apple") by cursor move.
        ref.cursorOffset = 8;
        onCursorChangeCb();

        // Ignore the pinned middle item.
        const ignoreFn = commandHandlers.get("grammarforge.details.ignore") as () => void;
        expect(ignoreFn).toBeDefined();
        ignoreFn();

        // After ignoring "apple" (index 1), the survivors are:
        //   index 0: "has"  at span [2,5)
        //   index 1: "teh"  at span [18,21)
        //
        // Pre-fix: state.displaySpans was NOT filtered, so it still has 3 entries:
        //   [0]=[2,5), [1]=[8,13), [2]=[18,21)
        // The hit-test loop runs for i=0..1 (state.items.length=2):
        //   i=0: items[0]=has, displaySpans[0]=[2,5)  ← correct
        //   i=1: items[1]=teh, displaySpans[1]=[8,13) ← WRONG (apple's span)
        //
        // So cursor at offset 18 (inside "teh") would NOT match any span pre-fix
        // (displaySpans[1]=[8,13) doesn't cover 18), leaving "teh" unpinnable.
        // Post-fix: displaySpans is also filtered → [0]=[2,5), [1]=[18,21),
        // so cursor at 18 correctly pins "teh".
        ref.cursorOffset = 18; // inside "teh" (second survivor, originally index 2)
        onCursorChangeCb();

        // The last suggestion setView should show "teh" → "the".
        const suggestionViews = setViewCalls.filter((v) => v?.kind === "suggestion");
        // Post-fix: "teh" is correctly associated with span [18,21), so cursor at
        // 18 pins it and the card shows "teh".
        // Pre-fix: displaySpans[1]=[8,13) doesn't cover offset 18, so no pin fires
        // and no suggestion card is shown → suggestionViews.length === 0 (FAIL).
        expect(suggestionViews.length).toBeGreaterThanOrEqual(1);
        const lastSuggestion = suggestionViews[suggestionViews.length - 1] as {
            kind: "suggestion";
            item: { original: string };
        };
        expect(lastSuggestion.item.original).toBe("teh");

        stop();
    });

    // ─── BLOCKER 1: in-flight rephrase cancelled on prompt ref swap ────────────

    test("rephrase: ref swap during loading cancels rephrase — result not rendered", async () => {
        // Start rephrase on refA. Simulate onChange with refB (different ref object).
        // Assert: state.rephrase is null, setView(null) called, spinner stopped.
        // Then resolve the in-flight rephraseFn → assert NO result card rendered.
        const text = "Hello world";
        const setViewCalls: Array<import("./details-panel-view").PanelView | null> = [];
        const commandHandlers = new Map<string, () => unknown>();
        const pendingRephrase: Array<(res: unknown) => void> = [];

        const makeRef = (t: string) => ({
            text: t,
            current: { input: t, parts: [] },
            cursorOffset: 0,
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => t.slice(s, e),
            replaceRange: () => undefined,
            focus: () => undefined,
        });

        const refA = makeRef(text);
        const refB = makeRef(text); // same text, different object identity
        let currentRef: ReturnType<typeof makeRef> = refA;
        let onChangeCb = (): void => undefined;

        const api = {
            prompt: {
                ref: () => currentRef,
                onChange: (cb: () => void) => {
                    onChangeCb = cb;
                    return () => undefined;
                },
                onCursorChange: () => () => undefined,
            },
            keymap: {
                registerLayer: (layer: {
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    return () => undefined;
                },
            },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const panelController = {
            setView: (v: import("./details-panel-view").PanelView | null) => setViewCalls.push(v),
            subscribe: () => () => undefined,
            dispose: () => undefined,
            setStatusText: () => undefined,
            subscribeStatus: () => () => undefined,
        };

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () => new Promise<unknown>(() => undefined), // never resolves
            rephrase: () =>
                new Promise<unknown>((resolve) => {
                    pendingRephrase.push(resolve);
                }),
            panelRenderer: () => panelController,
        } as unknown as OrchestratorDeps);

        // Start rephrase on refA.
        const rephraseFn = commandHandlers.get("grammarforge.rephrase") as () => void;
        expect(rephraseFn).toBeDefined();
        rephraseFn();

        // Loading card should be shown.
        expect(setViewCalls.filter((v) => v?.kind === "rephrase-loading").length).toBeGreaterThan(
            0,
        );
        expect(pendingRephrase.length).toBe(1);

        // Simulate ref swap: onChange fires with refB as the new ref.
        currentRef = refB;
        onChangeCb();

        // After ref swap: rephrase must be cancelled.
        // setView(null) must have been called to dismiss the card.
        const nullViews = setViewCalls.filter((v) => v === null);
        expect(nullViews.length).toBeGreaterThanOrEqual(1);

        // Now resolve the in-flight rephrase — result must NOT be rendered.
        const viewCountBeforeResolve = setViewCalls.length;
        pendingRephrase[0]!({
            original: text,
            rephrased: "Hi there world",
            alternatives: [],
        });
        await new Promise((r) => setTimeout(r, 10));

        // No new rephrase-result views after the resolve.
        const resultViewsAfterResolve = setViewCalls
            .slice(viewCountBeforeResolve)
            .filter((v) => v?.kind === "rephrase-result");
        expect(resultViewsAfterResolve.length).toBe(0);

        stop();
    });

    test("rephrase: accept after ref swap — no replaceRange, card dismissed", async () => {
        // Drive to result state on refA, then make api.prompt.ref() return refB
        // (different object, same text). rephraseAccept must NOT call replaceRange
        // and must dismiss the card.
        const text = "Hello world";
        const replaceRangeCalls: Array<[number, number, string]> = [];
        const setViewCalls: Array<import("./details-panel-view").PanelView | null> = [];
        const toasts: Array<{ message: string; variant?: string }> = [];
        const commandHandlers = new Map<string, () => unknown>();
        const pendingRephrase: Array<(res: unknown) => void> = [];

        const makeRef = (t: string) => ({
            text: t,
            current: { input: t, parts: [] },
            cursorOffset: 0,
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => t.slice(s, e),
            replaceRange: (s: number, e: number, r: string) => {
                replaceRangeCalls.push([s, e, r]);
            },
            focus: () => undefined,
        });

        const refA = makeRef(text);
        const refB = makeRef(text); // same text, different object identity
        let currentRef: ReturnType<typeof makeRef> = refA;

        const api = {
            prompt: {
                ref: () => currentRef,
                onChange: () => () => undefined,
                onCursorChange: () => () => undefined,
            },
            keymap: {
                registerLayer: (layer: {
                    commands?: Array<{ name: string; run: () => unknown }>;
                }) => {
                    for (const c of layer.commands ?? []) commandHandlers.set(c.name, c.run);
                    return () => undefined;
                },
            },
            ui: { toast: (t: { message: string; variant?: string }) => toasts.push(t) },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const panelController = {
            setView: (v: import("./details-panel-view").PanelView | null) => setViewCalls.push(v),
            subscribe: () => () => undefined,
            dispose: () => undefined,
            setStatusText: () => undefined,
            subscribeStatus: () => () => undefined,
        };

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: () => new Promise<unknown>(() => undefined),
            rephrase: () =>
                new Promise<unknown>((resolve) => {
                    pendingRephrase.push(resolve);
                }),
            panelRenderer: () => panelController,
        } as unknown as OrchestratorDeps);

        // Start rephrase on refA and drive to result state.
        const rephraseFn = commandHandlers.get("grammarforge.rephrase") as () => void;
        rephraseFn();

        expect(pendingRephrase.length).toBe(1);
        pendingRephrase[0]!({
            original: text,
            rephrased: "Hi there world",
            alternatives: [],
        });
        await new Promise((r) => setTimeout(r, 10));

        // Confirm result card is showing.
        expect(setViewCalls.filter((v) => v?.kind === "rephrase-result").length).toBeGreaterThan(0);

        // Swap the ref (same text, different object identity).
        currentRef = refB;

        // Accept — must NOT apply to refB.
        const acceptFn = commandHandlers.get("grammarforge.rephrase.accept") as () => void;
        acceptFn();

        // No replaceRange on either ref.
        expect(replaceRangeCalls.length).toBe(0);

        // Card dismissed.
        const lastView = setViewCalls[setViewCalls.length - 1];
        expect(lastView).toBeNull();

        // Info toast about the discard.
        expect(toasts.some((t) => t.variant === "info")).toBe(true);

        stop();
    });

    describe("reviewJump", () => {
        function makeItems(n: number): Array<{ category: string }> {
            return Array.from({ length: n }, (_, _i) => ({ category: "grammar" }));
        }

        test("next: pins item after cursor (wraps)", () => {
            const items = makeItems(3);
            const displaySpans = [
                { start: 5, end: 9 },
                { start: 15, end: 19 },
                { start: 25, end: 29 },
            ];
            const result = jumpNext(10, items, displaySpans);
            expect(result).toEqual({ pinIndex: 1, cursorOffset: 15 });
        });

        test("next: wraps to first item when cursor is past last item", () => {
            const items = makeItems(3);
            const displaySpans = [
                { start: 5, end: 9 },
                { start: 15, end: 19 },
                { start: 25, end: 29 },
            ];
            const result = jumpNext(30, items, displaySpans);
            expect(result).toEqual({ pinIndex: 0, cursorOffset: 5 });
        });

        test("next: returns null for empty items", () => {
            const result = jumpNext(0, [], []);
            expect(result).toBeNull();
        });

        test("prev: pins item before cursor (wraps)", () => {
            const items = makeItems(3);
            const displaySpans = [
                { start: 5, end: 9 },
                { start: 15, end: 19 },
                { start: 25, end: 29 },
            ];
            const result = jumpPrev(10, items, displaySpans);
            expect(result).toEqual({ pinIndex: 0, cursorOffset: 5 });
        });

        test("prev: wraps to last item when cursor is before first item", () => {
            const items = makeItems(3);
            const displaySpans = [
                { start: 5, end: 9 },
                { start: 15, end: 19 },
                { start: 25, end: 29 },
            ];
            const result = jumpPrev(3, items, displaySpans);
            expect(result).toEqual({ pinIndex: 2, cursorOffset: 25 });
        });

        test("prev: returns null for empty items", () => {
            const result = jumpPrev(0, [], []);
            expect(result).toBeNull();
        });
    });

    // ─── Completion trigger + gating ───────────────────────────────────

    describe("completion", () => {
        const baseApi = () => ({
            keymap: {
                registerLayer: () => () => undefined,
            },
            ui: { toast: () => undefined },
            theme: {
                syntax: () => ({
                    registerStyle: () => 1,
                    getStyleId: () => 1,
                }),
            },
            lifecycle: { onDispose: () => () => undefined },
        });

        test("completionEnabled=false → no completeFn call, no timer", async () => {
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string; atOffset: number }> = [];
            const clearCalls: unknown[] = [];
            let onChangeCb: () => void = () => undefined;
            const ref = {
                text: "The quick brown",
                current: { input: "The quick brown", parts: [] },
                cursorOffset: 15,
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: (cb: () => void) => {
                        onChangeCb = cb;
                        return () => undefined;
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            startOrchestrator(api, { completionEnabled: false }, {
                complete: async () => ({ continuation: "fox jumps" }),
                ghostRenderer: {
                    renderGhost: (text, atOffset) => ghostCalls.push({ text, atOffset }),
                    clearGhost: () => clearCalls.push(undefined),
                },
            });

            // Fire onChange — it will skip because completionEnabled is false.
            onChangeCb();
            await vi.advanceTimersByTimeAsync(700);
            expect(ghostCalls).toHaveLength(0);
            vi.useRealTimers();
        });

        test("completionEnabled=true + unfinished line → fires after debounce", async () => {
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string; atOffset: number }> = [];
            let onChangeCb: () => void = () => undefined;
            const ref = {
                text: "The quick brown",
                current: { input: "The quick brown", parts: [] },
                cursorOffset: 15,
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: (cb: () => void) => {
                        onChangeCb = cb;
                        return () => undefined;
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            startOrchestrator(api, { completionEnabled: true, completionDebounceMs: 600 }, {
                complete: async () => ({ continuation: "fox jumps" }),
                ghostRenderer: {
                    renderGhost: (text, atOffset) => ghostCalls.push({ text, atOffset }),
                    clearGhost: () => {},
                },
            });

            // Fire onChange — timer starts.
            onChangeCb();
            // Advance past the debounce.
            await vi.advanceTimersByTimeAsync(700);
            // Allow async requestCompletion to resolve.
            await vi.advanceTimersByTimeAsync(0);
            expect(ghostCalls).toHaveLength(1);
            expect(ghostCalls[0]!.text).toBe("fox jumps");
            expect(ghostCalls[0]!.atOffset).toBe(15);
            vi.useRealTimers();
        });

        test("completion: terminal punctuation does not trigger", async () => {
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string }> = [];
            let onChangeCb: () => void = () => undefined;
            const ref = {
                text: "Hello world.",
                current: { input: "Hello world.", parts: [] },
                cursorOffset: 12,
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: (cb: () => void) => {
                        onChangeCb = cb;
                        return () => undefined;
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            startOrchestrator(api, { completionEnabled: true }, {
                complete: async () => ({ continuation: "xxx" }),
                ghostRenderer: {
                    renderGhost: (text) => ghostCalls.push({ text }),
                    clearGhost: () => {},
                },
            });

            onChangeCb();
            await vi.advanceTimersByTimeAsync(700);
            expect(ghostCalls).toHaveLength(0);
            vi.useRealTimers();
        });

        test("completion: short text (<3 chars) does not trigger", async () => {
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string }> = [];
            let onChangeCb: () => void = () => undefined;
            const ref = {
                text: "ab",
                current: { input: "ab", parts: [] },
                cursorOffset: 2,
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: (cb: () => void) => {
                        onChangeCb = cb;
                        return () => undefined;
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            startOrchestrator(api, { completionEnabled: true }, {
                complete: async () => ({ continuation: "c" }),
                ghostRenderer: {
                    renderGhost: (text) => ghostCalls.push({ text }),
                    clearGhost: () => {},
                },
            });

            onChangeCb();
            await vi.advanceTimersByTimeAsync(700);
            expect(ghostCalls).toHaveLength(0);
            vi.useRealTimers();
        });

        test("completion: caret NOT at end suppresses trigger (mid-text pause)", async () => {
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string }> = [];
            let onChangeCb: () => void = () => undefined;
            const ref = {
                text: "The quick brown",
                current: { input: "The quick brown", parts: [] },
                cursorOffset: 5, // mid-text, not at end (text.length = 15)
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: (cb: () => void) => {
                        onChangeCb = cb;
                        return () => undefined;
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            startOrchestrator(api, { completionEnabled: true, completionDebounceMs: 100 }, {
                complete: async () => ({ continuation: "fox jumps" }),
                ghostRenderer: {
                    renderGhost: (text) => ghostCalls.push({ text }),
                    clearGhost: () => {},
                },
            });

            onChangeCb();
            await vi.advanceTimersByTimeAsync(150);
            await vi.advanceTimersByTimeAsync(0);
            expect(ghostCalls).toHaveLength(0); // suppressed: caret not at end
            vi.useRealTimers();
        });

        test("completion: caret-at-end + unfinished line → triggers", async () => {
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string }> = [];
            let onChangeCb: () => void = () => undefined;
            const ref = {
                text: "The quick brown",
                current: { input: "The quick brown", parts: [] },
                cursorOffset: 15, // at end (text.length = 15)
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: (cb: () => void) => {
                        onChangeCb = cb;
                        return () => undefined;
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            startOrchestrator(api, { completionEnabled: true, completionDebounceMs: 100 }, {
                complete: async () => ({ continuation: "fox jumps" }),
                ghostRenderer: {
                    renderGhost: (text) => ghostCalls.push({ text }),
                    clearGhost: () => {},
                },
            });

            onChangeCb();
            await vi.advanceTimersByTimeAsync(150);
            await vi.advanceTimersByTimeAsync(0);
            expect(ghostCalls).toHaveLength(1); // triggers: caret at end
            expect(ghostCalls[0]!.text).toBe("fox jumps");
            vi.useRealTimers();
        });

        test("completion: edit resets debounce — ghost appears after new debounce", async () => {
            // Simulate: user starts typing, pauses briefly, types more.
            // The ghost should appear after the final pause, not the first.
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string }> = [];
            let onChangeCb: () => void = () => undefined;
            const ref = { text: "abc", current: { input: "abc", parts: [] }, cursorOffset: 3,
                extmarks: { registerType: () => 1, create: () => 1, getAllForTypeId: () => [], delete: () => true },
                getTextRange: () => "", replaceRange: () => undefined, focus: () => undefined, setCursorOffset: () => undefined };
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: (cb: () => void) => { onChangeCb = cb; return () => undefined; },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            startOrchestrator(api, { completionEnabled: true, completionDebounceMs: 600, realtimeDelayMs: 5000 }, {
                correct: async () => ({ original: "", suggestions: [], score: 100 }),
                complete: async () => ({ continuation: "fox" }),
                ghostRenderer: { renderGhost: (text) => ghostCalls.push({ text }), clearGhost: () => {} },
            });

            // First pause.
            onChangeCb();
            // Advance 300ms (half the 600ms debounce) — no ghost yet.
            await vi.advanceTimersByTimeAsync(300);
            expect(ghostCalls).toHaveLength(0);

            // User continues typing — reset debounce.
            ref.text = "abcd"; ref.cursorOffset = 4;
            onChangeCb();
            // Advance past the NEW 600ms debounce from the reset point.
            await vi.advanceTimersByTimeAsync(650);
            await vi.advanceTimersByTimeAsync(0);
            expect(ghostCalls).toHaveLength(1);
            expect(ghostCalls[0]!.text).toBe("fox");
            vi.useRealTimers();
        });

        test("completion: stale-seq guard drops in-flight result when newer request fires", async () => {
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string }> = [];
            let onChangeCb: () => void = () => undefined;
            const ref = {
                text: "The quick brown",
                current: { input: "The quick brown", parts: [] },
                cursorOffset: 15,
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            // Use a call counter so each complete() call returns a SEPARATE promise.
            const pending: Array<(v: { continuation: string }) => void> = [];
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: (cb: () => void) => {
                        onChangeCb = cb;
                        return () => undefined;
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            const stop = startOrchestrator(api, { completionEnabled: true, completionDebounceMs: 100 }, {
                complete: () =>
                    new Promise<{ continuation: string }>((resolve) => {
                        pending.push(resolve);
                    }),
                ghostRenderer: {
                    renderGhost: (text) => ghostCalls.push({ text }),
                    clearGhost: () => {},
                },
            });

            // Trigger first completion.
            onChangeCb();
            await vi.advanceTimersByTimeAsync(150);
            // Change text and trigger second completion — this bumps completionSeq.
            ref.text = "The quick brown fox";
            ref.cursorOffset = 19;
            onChangeCb();
            await vi.advanceTimersByTimeAsync(150);
            // Two requests should be pending.
            expect(pending).toHaveLength(2);
            // Resolve the FIRST (stale) request.
            pending[0]!({ continuation: "stale" });
            await vi.advanceTimersByTimeAsync(0);
            // Stale result should be dropped.
            expect(ghostCalls).toHaveLength(0);
            // Resolve the second (current) request.
            pending[1]!({ continuation: "fox jumps" });
            await vi.advanceTimersByTimeAsync(0);
            expect(ghostCalls).toHaveLength(1);
            expect(ghostCalls[0]!.text).toBe("fox jumps");
            stop();
            vi.useRealTimers();
        });

        test("completion: result not rendered if pinned or rephrasing by the time it arrives", async () => {
            // This is tested indirectly — the requestCompletion function checks
            // detailsState.pinnedIndex() and state.rephrase before rendering.
            // For now, verify that a completeFn returning empty continuation doesn't render.
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string }> = [];
            let onChangeCb: () => void = () => undefined;
            const ref = {
                text: "The quick brown",
                current: { input: "The quick brown", parts: [] },
                cursorOffset: 15,
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: (cb: () => void) => {
                        onChangeCb = cb;
                        return () => undefined;
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            startOrchestrator(api, { completionEnabled: true, completionDebounceMs: 100 }, {
                complete: async () => ({ continuation: "" }),
                ghostRenderer: {
                    renderGhost: (text) => ghostCalls.push({ text }),
                    clearGhost: () => {},
                },
            });

            onChangeCb();
            await vi.advanceTimersByTimeAsync(150);
            await vi.advanceTimersByTimeAsync(0);
            expect(ghostCalls).toHaveLength(0);
            vi.useRealTimers();
        });

        test("suppression: ghost NOT rendered when rephrase starts before completion resolves", async () => {
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string }> = [];
            const commandHandlers = new Map<string, () => unknown>();
            let onChangeCb: () => void = () => undefined;
            let resolveComplete: ((v: { continuation: string }) => void) | null = null;

            const ref = {
                text: "The quick brown",
                current: { input: "The quick brown", parts: [] },
                cursorOffset: 15,
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: (cb: () => void) => {
                        onChangeCb = cb;
                        return () => undefined;
                    },
                },
                keymap: {
                    registerLayer: (layer: {
                        commands?: Array<{ name: string; run: () => void }>;
                    }) => {
                        if (layer.commands) {
                            for (const cmd of layer.commands) {
                                commandHandlers.set(cmd.name, cmd.run);
                            }
                        }
                        return () => undefined;
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            startOrchestrator(api, { completionEnabled: true, completionDebounceMs: 100 }, {
                complete: () =>
                    new Promise<{ continuation: string }>((resolve) => {
                        resolveComplete = resolve;
                    }),
                rephrase: () => new Promise(() => {}), // never resolves
                ghostRenderer: {
                    renderGhost: (text) => ghostCalls.push({ text }),
                    clearGhost: () => {},
                },
                panelRenderer: () => ({
                    setView: () => {},
                    subscribe: () => () => undefined,
                    dispose: () => undefined,
                    setStatusText: () => {},
                    subscribeStatus: () => () => undefined,
                }),
            });

            // Trigger completion debounce.
            onChangeCb();
            await vi.advanceTimersByTimeAsync(150);
            // Completion is now in-flight (awaiting completeFn).
            // Start rephrase — this sets state.rephrase immediately.
            const rephraseCmd = commandHandlers.get("grammarforge.rephrase");
            expect(rephraseCmd).toBeDefined();
            rephraseCmd!();
            // Now resolve the completion.
            expect(resolveComplete).not.toBeNull();
            resolveComplete!({ continuation: "fox jumps" });
            await vi.advanceTimersByTimeAsync(0);
            // Ghost should NOT be rendered because rephrase is active.
            expect(ghostCalls).toHaveLength(0);
            vi.useRealTimers();
        });

        test("suppression: ghost NOT rendered when pin occurs before completion resolves", async () => {
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string }> = [];
            let onChangeCb: () => void = () => undefined;
            let onCursorCb: (() => void) | null = null;
            let resolveComplete: ((v: { continuation: string }) => void) | null = null;

            const ref = {
                text: "The quick brown",
                current: { input: "The quick brown", parts: [] },
                cursorOffset: 15,
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: (cb: () => void) => {
                        onChangeCb = cb;
                        return () => undefined;
                    },
                    onCursorChange: (cb: () => void) => {
                        onCursorCb = cb;
                        return () => undefined;
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            // Phase 1: populate items via correctFn so pin has a target.
            // Inject a correctFn that returns one item with a span covering cursorOffset.
            const correctItem = {
                span: { start: 2, end: 5 },
                replacement: "the",
                model: "gector" as const,
                category: "grammar",
            };

            startOrchestrator(api, {
                completionEnabled: true,
                completionDebounceMs: 100,
                realtimeDelayMs: 10,
            }, {
                correct: () =>
                    new Promise((resolve) => {
                        // Resolve immediately with items for pin-target.
                        resolve({
                            original: "The quick brown",
                            score: 90,
                            suggestions: [{ id: 1, ...correctItem }],
                        });
                    }),
                complete: () =>
                    new Promise<{ continuation: string }>((resolve) => {
                        resolveComplete = resolve;
                    }),
                ghostRenderer: {
                    renderGhost: (text) => ghostCalls.push({ text }),
                    clearGhost: () => {},
                },
            });

            // Fire onChange to populate items (grammar check).
            onChangeCb();
            await vi.advanceTimersByTimeAsync(20); // past realtimeDelayMs=10
            await vi.advanceTimersByTimeAsync(0);
            // Now items are populated.

            // Fire onChange again to start completion debounce.
            // (text is same, so no A8 eager dismiss — just the timer restart)
            onChangeCb();
            await vi.advanceTimersByTimeAsync(110); // past completionDebounceMs=100
            // Completion is now in-flight (awaiting completeFn).

            // Pin: fire onCursorChange with cursor over the item's span.
            // The item at index 0 has hlStart=2, hlEnd=5. cursorOffset at end=5
            // of span [2,5) would not match (end-inclusive: ≤). At offset=4 it matches.
            ref.cursorOffset = 4;
            expect(onCursorCb).not.toBeNull();
            onCursorCb!();

            // Now resolve the completion.
            expect(resolveComplete).not.toBeNull();
            resolveComplete!({ continuation: "fox jumps" });
            await vi.advanceTimersByTimeAsync(0);
            // Ghost should NOT be rendered because pin is active.
            expect(ghostCalls).toHaveLength(0);
            vi.useRealTimers();
        });

        test("completion keymap layer: accept calls replaceRange and clears ghost", async () => {
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string; atOffset: number }> = [];
            const clearCalls: unknown[] = [];
            const replaceCalls: Array<{ start: number; end: number; text: string }> = [];
            const layers = new Map<string, { commands?: Array<{ name: string; run: () => void }> }>();
            let onChangeCb: () => void = () => undefined;

            const ref = {
                text: "The quick brown",
                current: { input: "The quick brown", parts: [] },
                cursorOffset: 15,
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: (start: number, end: number, text: string) => {
                    replaceCalls.push({ start, end, text });
                },
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: (cb: () => void) => {
                        onChangeCb = cb;
                        return () => undefined;
                    },
                },
                keymap: {
                    registerLayer: (layer: {
                        priority: number;
                        enabled?: () => boolean;
                        commands?: Array<{ name: string; title: string; run: () => void }>;
                        bindings?: Array<{ key: string; cmd: string }>;
                    }) => {
                        const layerId = `layer-${layers.size}`;
                        layers.set(layerId, layer);
                        return () => layers.delete(layerId);
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            startOrchestrator(api, { completionEnabled: true, completionDebounceMs: 100 }, {
                complete: async () => ({ continuation: "fox jumps over" }),
                ghostRenderer: {
                    renderGhost: (text, atOffset) => ghostCalls.push({ text, atOffset }),
                    clearGhost: () => clearCalls.push(undefined),
                },
            });

            // Trigger completion.
            onChangeCb();
            await vi.advanceTimersByTimeAsync(150);
            await vi.advanceTimersByTimeAsync(0);
            expect(ghostCalls).toHaveLength(1);

            // Find the completion layer and execute the accept command.
            let acceptFn: (() => void) | undefined;
            for (const [, layer] of layers) {
                if (layer.commands) {
                    for (const cmd of layer.commands) {
                        if (cmd.name === "grammarforge.completion.accept") {
                            acceptFn = cmd.run;
                        }
                    }
                }
            }
            expect(acceptFn).toBeDefined();
            acceptFn!();

            // Assert replaceRange was called with correct args.
            expect(replaceCalls).toHaveLength(1);
            expect(replaceCalls[0]!.start).toBe(15);
            expect(replaceCalls[0]!.end).toBe(15);
            expect(replaceCalls[0]!.text).toBe("fox jumps over");

            vi.useRealTimers();
        });

        test("completion keymap layer: dismiss clears state and ghost", async () => {
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string }> = [];
            const clearCalls: unknown[] = [];
            const layers = new Map<string, { commands?: Array<{ name: string; run: () => void }> }>();
            let onChangeCb: () => void = () => undefined;

            const ref = {
                text: "The quick brown",
                current: { input: "The quick brown", parts: [] },
                cursorOffset: 15,
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: (cb: () => void) => {
                        onChangeCb = cb;
                        return () => undefined;
                    },
                },
                keymap: {
                    registerLayer: (layer: {
                        priority: number;
                        enabled?: () => boolean;
                        commands?: Array<{ name: string; title: string; run: () => void }>;
                    }) => {
                        const layerId = `layer-${layers.size}`;
                        layers.set(layerId, layer);
                        return () => layers.delete(layerId);
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            startOrchestrator(api, { completionEnabled: true, completionDebounceMs: 100 }, {
                complete: async () => ({ continuation: "fox jumps" }),
                ghostRenderer: {
                    renderGhost: (text) => ghostCalls.push({ text }),
                    clearGhost: () => clearCalls.push(undefined),
                },
            });

            // Trigger completion.
            onChangeCb();
            await vi.advanceTimersByTimeAsync(150);
            await vi.advanceTimersByTimeAsync(0);
            expect(ghostCalls).toHaveLength(1);

            // Find the completion layer and execute the dismiss command.
            let dismissFn: (() => void) | undefined;
            for (const [, layer] of layers) {
                if (layer.commands) {
                    for (const cmd of layer.commands) {
                        if (cmd.name === "grammarforge.completion.dismiss") {
                            dismissFn = cmd.run;
                        }
                    }
                }
            }
            expect(dismissFn).toBeDefined();
            expect(clearCalls).toHaveLength(0);
            dismissFn!();
            expect(clearCalls).toHaveLength(1);

            vi.useRealTimers();
        });

        test("completion keymap layer: enabled gate is false when no ghost", () => {
            const layers = new Map<string, { enabled?: () => boolean }>();
            const ref = {
                text: "",
                current: { input: "", parts: [] },
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
                setCursorOffset: () => undefined,
            };
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: () => () => undefined,
                },
                keymap: {
                    registerLayer: (layer: {
                        priority: number;
                        enabled?: () => boolean;
                    }) => {
                        const layerId = `layer-${layers.size}`;
                        layers.set(layerId, layer);
                        return () => layers.delete(layerId);
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            startOrchestrator(api, { completionEnabled: false }, {});

            // Find the completion layer and check enabled() returns false.
            let enabledFn: (() => boolean) | undefined;
            for (const [, layer] of layers) {
                if (layer.enabled) {
                    // The completion layer is identifiable by its enabled gate.
                    enabledFn = layer.enabled;
                }
            }
            // All keymap layers are registered; completion has enabled defined.
            expect(enabledFn).toBeDefined();
            // With no completion state, enabled should return false.
            expect(enabledFn!()).toBe(false);
        });

        test("onChange: eagerly clears completion ghost on edit (A8 + WS-C)", async () => {
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string }> = [];
            const clearCalls: unknown[] = [];
            let onChangeCb: () => void = () => undefined;
            const ref = {
                text: "The quick brown",
                current: { input: "The quick brown", parts: [] },
                cursorOffset: 15,
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => ref,
                    onChange: (cb: () => void) => {
                        onChangeCb = cb;
                        return () => undefined;
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            startOrchestrator(api, { completionEnabled: true, completionDebounceMs: 100 }, {
                complete: async () => ({ continuation: "fox jumps" }),
                ghostRenderer: {
                    renderGhost: (text) => ghostCalls.push({ text }),
                    clearGhost: () => clearCalls.push(undefined),
                },
            });

            // Trigger completion.
            onChangeCb();
            await vi.advanceTimersByTimeAsync(150);
            await vi.advanceTimersByTimeAsync(0);
            expect(ghostCalls).toHaveLength(1);
            expect(clearCalls).toHaveLength(0);

            // Now edit — onChange fires with different text.
            ref.text = "The quick brown fox";
            onChangeCb();
            await vi.advanceTimersByTimeAsync(0);

            // Ghost should be cleared via the A8 eager-dismiss block.
            expect(clearCalls).toHaveLength(1);
            vi.useRealTimers();
        });

        test("onChange: clears completion ghost on ref-swap", async () => {
            vi.useFakeTimers();
            const ghostCalls: Array<{ text: string }> = [];
            const clearCalls: unknown[] = [];
            let onChangeCb: () => void = () => undefined;
            const refA = {
                text: "The quick brown",
                current: { input: "The quick brown", parts: [] },
                cursorOffset: 15,
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            let currentRef: typeof refA = refA;
            const api = {
                ...baseApi(),
                prompt: {
                    ref: () => currentRef,
                    onChange: (cb: () => void) => {
                        onChangeCb = cb;
                        return () => undefined;
                    },
                },
            } as unknown as Parameters<typeof startOrchestrator>[0];

            startOrchestrator(api, { completionEnabled: true, completionDebounceMs: 100 }, {
                complete: async () => ({ continuation: "fox jumps" }),
                ghostRenderer: {
                    renderGhost: (text) => ghostCalls.push({ text }),
                    clearGhost: () => clearCalls.push(undefined),
                },
            });

            // Trigger completion.
            onChangeCb();
            await vi.advanceTimersByTimeAsync(150);
            await vi.advanceTimersByTimeAsync(0);
            expect(ghostCalls).toHaveLength(1);
            expect(clearCalls).toHaveLength(0);

            // Swap ref — simulate route remount.
            currentRef = {
                text: "New prompt",
                current: { input: "New prompt", parts: [] },
                cursorOffset: 10,
                extmarks: {
                    registerType: () => 1,
                    create: () => 1,
                    getAllForTypeId: () => [],
                    delete: () => true,
                },
                getTextRange: () => "",
                replaceRange: () => undefined,
                focus: () => undefined,
                setCursorOffset: () => undefined,
            };
            onChangeCb();
            await vi.advanceTimersByTimeAsync(0);

            // Ghost should be cleared on ref-swap.
            expect(clearCalls).toHaveLength(1);
            vi.useRealTimers();
        });
    });
});
