// GrammarForge OpenCode TUI plugin: bridge wiring + keymap + extmark layer.
// Sole wirer for the prompt; all UX is read-only (the plugin SUGGESTS — the
// user applies via hotkey or the Apply affordance). The hot path is:
//   onChange → debounce → client.correct({text, source:"opencode"})
//   → buildRenderableItems → map cu→display → extmark create
// The accept hotkey is the single write path; it also enqueues a
// "accepted" signal so the bridge's edit-level log can attribute it.

import { BridgeClient, type SignalEvent } from "@/api/client";
import { buildRenderableItems, isSpanStillValid, type RenderableItem } from "@/lib/pipeline";
import { createSignalQueue } from "@/signal/queue";
import type { CorrectRequest, CorrectResponse } from "@/api/types";
import { displaySpanFromCodeUnits, makeDisplayWidth, bunSegmentWidth } from "./display-width";
import { collectPartRanges, overlapsAnyRange, type DisplaySpan } from "./part-filter";
import type { PromptRef, TuiApi } from "./opencode-types";

const SIGNAL_SOURCE = "opencode";

// Display color per category. Mirrors CATEGORY_META.badge in
// clients/browser/src/api/category.ts — keep in sync if the browser
// palette changes. `badge` is the brighter of the two swatches per
// category and reads well as a terminal underline foreground on both
// light and dark backgrounds.
const CATEGORY_FG: Record<string, string> = {
    spelling: "#ef4444",
    grammar: "#eab308",
    punctuation: "#06b6d4",
    style: "#8b5cf6",
    typography: "#6b7280",
    unknown: "#9ca3af",
};

const DEFAULT_BRIDGE_URL = "http://localhost:8000";
const DEFAULT_REALTIME_DELAY_MS = 500;
const DEFAULT_ACCEPT_HOTKEY = "ctrl+.";

export interface GrammarForgeSettings {
    bridgeUrl: string;
    realtimeDelayMs: number;
    acceptHotkey: string;
    allowRemoteBridge: boolean;
}

export function resolveSettings(
    options: Record<string, unknown> | undefined,
): GrammarForgeSettings {
    const raw = options ?? {};
    const bridgeUrl =
        typeof raw.bridgeUrl === "string" && /^https?:\/\//.test(raw.bridgeUrl)
            ? raw.bridgeUrl.replace(/\/+$/, "")
            : DEFAULT_BRIDGE_URL;
    const realtimeDelayMs =
        typeof raw.realtimeDelayMs === "number" && Number.isFinite(raw.realtimeDelayMs)
            ? raw.realtimeDelayMs
            : DEFAULT_REALTIME_DELAY_MS;
    const acceptHotkeyRaw =
        typeof raw.acceptHotkey === "string" ? raw.acceptHotkey.trim().toLowerCase() : "";
    const acceptHotkey = acceptHotkeyRaw === "" ? DEFAULT_ACCEPT_HOTKEY : acceptHotkeyRaw;
    const allowRemoteBridge = raw.allowRemoteBridge === true;
    return { bridgeUrl, realtimeDelayMs, acceptHotkey, allowRemoteBridge };
}

export interface Decoration {
    start: number;
    end: number;
    category: string;
    itemIndex: number;
}

/** Map renderable items to display-width extmark spans. Drops empty spans
 *  (start === end) and any whose span overlaps a prompt-part range
 *  (pastes, file attachments, agent mentions) — the typed-input-only
 *  invariant. Word range (`hlStart/hlEnd`) is used so zero-width insertions
 *  still highlight their target word. */
export function suggestionsToDecorations(
    text: string,
    items: ReadonlyArray<{ hlStart: number; hlEnd: number; category: string }>,
    partRanges: ReadonlyArray<DisplaySpan>,
    displayWidthOf: (value: string) => number,
): Decoration[] {
    const out: Decoration[] = [];
    for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        const span: DisplaySpan = displaySpanFromCodeUnits(
            text,
            { start: it.hlStart, end: it.hlEnd },
            displayWidthOf,
        );
        if (span.start === span.end) continue;
        if (overlapsAnyRange(span, partRanges)) continue;
        out.push({ start: span.start, end: span.end, category: it.category, itemIndex: i });
    }
    return out;
}

interface RefState {
    items: RenderableItem[];
    checkedText: string;
    checkSeq: number;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    extmarkTypeId: number | null;
    activeExtmarkIds: number[];
}

function emptyRefState(): RefState {
    return {
        items: [],
        checkedText: "",
        checkSeq: 0,
        debounceTimer: null,
        extmarkTypeId: null,
        activeExtmarkIds: [],
    };
}

/** Test-only injection seam. Production callers leave this undefined; the
 *  orchestrator then uses `client.correct` against the real bridge. Tests
 *  inject a deferred `correct` so they can swap the prompt ref mid-flight
 *  and exercise the stale-fetch race guard. */
export interface OrchestratorDeps {
    correct?: (req: CorrectRequest) => Promise<CorrectResponse>;
}

export function startOrchestrator(
    api: TuiApi,
    options: Record<string, unknown> | undefined,
    deps?: OrchestratorDeps,
): () => void {
    // Unpatched OpenCode build (no prompt facade): warn once, return no-op.
    if (!api.prompt) {
        api.ui.toast({
            message: "GrammarForge: this OpenCode build lacks the prompt facade — plugin disabled",
            variant: "warning",
        });
        return () => undefined;
    }

    const settings = resolveSettings(options);
    const displayWidthOf = makeDisplayWidth(bunSegmentWidth);
    const client = new BridgeClient(settings.bridgeUrl, settings.allowRemoteBridge);
    const signalQueue = createSignalQueue({ send: (events) => client.signal(events) });
    const correctFn = deps?.correct ?? ((req: CorrectRequest) => client.correct(req));

    // Style id cache: category → styleId. Lazy; one registerStyle per
    // category the first time we see it.
    const styleIds = new Map<string, number>();
    const getStyleId = (category: string): number | null => {
        if (styleIds.has(category)) return styleIds.get(category) ?? null;
        const syntax = api.theme.syntax?.();
        if (!syntax) return null;
        const id = syntax.registerStyle(`extmark.grammarforge.${category}`, {
            underline: true,
            fg: CATEGORY_FG[category] ?? CATEGORY_FG.unknown,
        });
        styleIds.set(category, id);
        return id;
    };

    let trackedRef: PromptRef | null = null;
    const state: RefState = emptyRefState();

    const clearActiveExtmarks = (): void => {
        if (!trackedRef) return;
        for (const id of state.activeExtmarkIds) {
            try {
                trackedRef.extmarks.delete(id);
            } catch {
                // extmark id may have been invalidated by a ref swap; safe to ignore.
            }
        }
        state.activeExtmarkIds = [];
    };

    const renderDecorations = (ref: PromptRef, items: RenderableItem[]): void => {
        clearActiveExtmarks();
        // Re-register the type id when the ref identity changes — a route
        // remount replaces the underlying textarea, so old extmark ids
        // point at nothing.
        if (state.extmarkTypeId === null) {
            state.extmarkTypeId = ref.extmarks.registerType("grammarforge");
        }
        const partRanges = collectPartRanges(ref.current.parts);
        const decorations = suggestionsToDecorations(ref.text, items, partRanges, displayWidthOf);
        const typeId = state.extmarkTypeId;
        for (const d of decorations) {
            const styleId = getStyleId(d.category);
            if (styleId === null) continue;
            const id = ref.extmarks.create({
                start: d.start,
                end: d.end,
                virtual: true,
                styleId,
                typeId,
            });
            state.activeExtmarkIds.push(id);
        }
    };

    const runCheck = async (ref: PromptRef): Promise<void> => {
        const text = ref.text;
        if (text === "") {
            state.items = [];
            state.checkedText = "";
            clearActiveExtmarks();
            return;
        }
        const seq = ++state.checkSeq;
        try {
            const res = await correctFn({ text, source: SIGNAL_SOURCE });
            // Stale-seq guard: the ref-swap path bumps state.checkSeq to
            // invalidate every in-flight check against the OLD ref.
            if (seq !== state.checkSeq) return;
            // Re-read the LIVE ref (no ensureRef side-effect here — we must
            // not re-track mid-validation). Drop unless ALL of:
            //   - the ref we captured is still the live one,
            //   - trackedRef hasn't moved on (paranoia; equivalent to the
            //     previous check unless a SECOND swap landed),
            //   - the buffer text we sent hasn't drifted.
            const liveRef = api.prompt?.ref();
            if (liveRef !== ref) return;
            if (ref !== trackedRef) return;
            if (ref.text !== text) return;
            state.items = buildRenderableItems(text, res).items;
            state.checkedText = text;
            renderDecorations(ref, state.items);
        } catch {
            // Bridge unreachable / errored: silent idle, retry on the next change.
        }
    };

    const scheduleCheck = (ref: PromptRef): void => {
        if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
        state.debounceTimer = setTimeout(() => {
            state.debounceTimer = null;
            void runCheck(ref);
        }, settings.realtimeDelayMs);
    };

    const onChange = (): void => {
        const ref = api.prompt?.ref();
        if (!ref) return;
        // Ref swap (route remount → fresh textarea) — reset per-ref state
        // AND bump checkSeq to cancel any in-flight fetch against the old
        // ref (its post-await validation would otherwise see a matching
        // seq and render extmarks to the dead ref, polluting
        // activeExtmarkIds with the old controller's ids).
        if (ref !== trackedRef) {
            clearActiveExtmarks();
            state.checkSeq += 1;
            state.extmarkTypeId = null;
            trackedRef = ref;
            state.items = [];
            state.checkedText = "";
        }
        const text = ref.text;
        // Submit/clear detection: items open and the user just emptied the
        // buffer. Enqueue an "ignored" for every open item and clear.
        if (text === "" && state.items.length > 0 && state.checkedText !== "") {
            for (const it of state.items) {
                if (typeof it.id !== "number") continue;
                const ev: SignalEvent = { id: it.id, action: "ignored", source: SIGNAL_SOURCE };
                signalQueue.enqueue(ev);
            }
            void signalQueue.flush();
            state.items = [];
            state.checkedText = "";
            clearActiveExtmarks();
            return;
        }
        scheduleCheck(ref);
    };

    // Accept hotkey: apply the first item's primary replacement, stale-guarded.
    const acceptFirst = (): void => {
        const ref = api.prompt?.ref();
        if (!ref) return;
        if (state.items.length === 0) return;
        const item = state.items[0]!;
        if (!isSpanStillValid(ref.text, item)) {
            // Span moved → re-check rather than corrupt the buffer.
            scheduleCheck(ref);
            return;
        }
        const replacement = item.replacements[0] ?? "";
        const displaySpan = displaySpanFromCodeUnits(
            ref.text,
            { start: item.cuStart, end: item.cuEnd },
            displayWidthOf,
        );
        ref.replaceRange(displaySpan.start, displaySpan.end, replacement);
        if (typeof item.id === "number") {
            const ev: SignalEvent = {
                id: item.id,
                action: "accepted",
                category: item.category,
                source: SIGNAL_SOURCE,
            };
            signalQueue.enqueue(ev);
        }
        api.ui.toast({ message: `Applied: ${replacement || item.original}`, variant: "success" });
        // Re-render against the new text. The next onChange will also fire;
        // this just keeps the underlines fresh in the same frame.
        onChange();
    };

    const unsubscribeChange = api.prompt.onChange(onChange);
    const disposeKeymap = api.keymap.registerLayer({
        priority: 500,
        commands: [
            {
                name: "grammarforge.accept",
                title: "GrammarForge: accept first suggestion",
                run: acceptFirst,
            },
        ],
        bindings: [{ key: settings.acceptHotkey, cmd: "grammarforge.accept" }],
    });
    const onDispose = api.lifecycle.onDispose(() => {
        // Lifecycle owns its own teardown chain; nothing extra to do here.
    });

    // Prime: if a prompt is already mounted, do an initial check.
    const initialRef = api.prompt.ref();
    if (initialRef) {
        trackedRef = initialRef;
        scheduleCheck(initialRef);
    }

    return (): void => {
        if (state.debounceTimer !== null) {
            clearTimeout(state.debounceTimer);
            state.debounceTimer = null;
        }
        unsubscribeChange();
        disposeKeymap();
        onDispose();
        clearActiveExtmarks();
        void signalQueue.flush();
    };
}
