// GrammarForge OpenCode TUI plugin: bridge wiring + keymap + extmark layer.
// Sole wirer for the prompt; all UX is read-only (the plugin SUGGESTS — the
// user applies via hotkey or the Apply affordance). The hot path is:
//   onChange → debounce → client.correct({text, source:"opencode"})
//   → buildRenderableItems → map cu→display → extmark create
// The accept hotkey is the single write path; it also enqueues a
// "accepted" signal so the bridge's edit-level log can attribute it.
//
// Panel rendering lives in src/tui-entry.tsx (the bun-loaded source
// entry; see anthropic-auth/packages/opencode/src/tui.tsx for the
// reference pattern). This module is the testable model layer
// (vitest + Node, no FFI). The tui-entry imports this orchestrator
// through deps.panelRenderer — a factory the orchestrator never
// statically imports. The test-runner trap is preserved.
//
// All state transitions call GF_TUI_DEBUG=1 file logging (see
// src/debug.ts) for live-smoke instrumentation.

import { BridgeClient, type SignalEvent } from "@/api/client";
import { buildRenderableItems, isSpanStillValid, type RenderableItem } from "@/lib/pipeline";
import { createSignalQueue } from "@/signal/queue";
import { resolveCommonSettings } from "@/storage/settings-core";
import type {
    CorrectRequest,
    CorrectResponse,
    RephraseRequest,
    RephraseResponse,
} from "@/api/types";
import {
    displaySpanFromCodeUnits,
    displaySpansForItems,
    makeDisplayWidth,
    bunSegmentWidth,
} from "./display-width";
import { collectPartRanges, overlapsAnyRange, type DisplaySpan } from "./part-filter";
import { maskPastePlaceholders } from "./paste-mask";
import { createDetailsState, type DetailsState } from "./details-state";
import { detectPromptPinSupport } from "./feature-detect";
import { logDebug } from "./debug";
import { CATEGORY_FG } from "./category-palette";
import type { PromptRef, TuiApi } from "./opencode-types";
import type { PanelController, PanelView } from "./details-panel-view";

const SIGNAL_SOURCE = "opencode";

const DEFAULT_APPLY_ALL_HOTKEY = "ctrl+.";
const DEFAULT_CYCLE_NEXT_HOTKEY = "ctrl+n";
const DEFAULT_CYCLE_PREV_HOTKEY = "ctrl+p";
const DEFAULT_REPHRASE_HOTKEY = "ctrl+/";

export interface GrammarForgeSettings {
    bridgeUrl: string;
    realtimeDelayMs: number;
    applyAllHotkey: string;
    cycleNextHotkey: string;
    cyclePrevHotkey: string;
    rephraseHotkey: string;
    allowRemoteBridge: boolean;
}

export function resolveSettings(
    options: Record<string, unknown> | undefined,
): GrammarForgeSettings {
    const raw = options ?? {};
    const { common } = resolveCommonSettings(raw);
    const applyAllHotkeyRaw =
        typeof raw.applyAllHotkey === "string" ? raw.applyAllHotkey.trim().toLowerCase() : "";
    const applyAllHotkey = applyAllHotkeyRaw === "" ? DEFAULT_APPLY_ALL_HOTKEY : applyAllHotkeyRaw;
    const cycleNextHotkeyRaw =
        typeof raw.cycleNextHotkey === "string" ? raw.cycleNextHotkey.trim().toLowerCase() : "";
    const cycleNextHotkey =
        cycleNextHotkeyRaw === "" ? DEFAULT_CYCLE_NEXT_HOTKEY : cycleNextHotkeyRaw;
    const cyclePrevHotkeyRaw =
        typeof raw.cyclePrevHotkey === "string" ? raw.cyclePrevHotkey.trim().toLowerCase() : "";
    const cyclePrevHotkey =
        cyclePrevHotkeyRaw === "" ? DEFAULT_CYCLE_PREV_HOTKEY : cyclePrevHotkeyRaw;
    const rephraseHotkeyRaw =
        typeof raw.rephraseHotkey === "string" ? raw.rephraseHotkey.trim().toLowerCase() : "";
    const rephraseHotkey = rephraseHotkeyRaw === "" ? DEFAULT_REPHRASE_HOTKEY : rephraseHotkeyRaw;
    return {
        bridgeUrl: common.bridgeUrl,
        realtimeDelayMs: common.realtimeDelayMs,
        applyAllHotkey,
        cycleNextHotkey,
        cyclePrevHotkey,
        rephraseHotkey,
        allowRemoteBridge: common.allowRemoteBridge,
    };
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
 *  still highlight their target word.
 *
 *  Accepts PRECOMPUTED display spans (parallel to items, computed once at
 *  check-complete via displaySpansForItems) instead of recomputing per call.
 *  This eliminates the O(text × items) cost on the debounced check path. */
export function suggestionsToDecorations(
    spans: ReadonlyArray<DisplaySpan>,
    items: ReadonlyArray<{ category: string }>,
    partRanges: ReadonlyArray<DisplaySpan>,
): Decoration[] {
    const out: Decoration[] = [];
    const len = Math.min(spans.length, items.length);
    for (let i = 0; i < len; i++) {
        const span = spans[i]!;
        const it = items[i]!;
        if (span.start === span.end) continue;
        if (overlapsAnyRange(span, partRanges)) continue;
        out.push({ start: span.start, end: span.end, category: it.category, itemIndex: i });
    }
    return out;
}

interface RephraseState {
    mode: "loading" | "result";
    original: string;
    rephrased?: string;
    /** Monotonic sequence number — incremented on each new rephrase
     *  invocation and on reject/cancel. In-flight async callbacks
     *  compare against this to detect stale results. */
    seq: number;
    /** The prompt ref that was active when this rephrase started.
     *  Used to detect ref swaps (route remounts) and discard stale
     *  results that arrived for a different prompt instance. */
    ref: PromptRef;
}

interface RefState {
    items: RenderableItem[];
    /** Precomputed display spans parallel to `items`, computed once at
     *  check-complete via displaySpansForItems. Cached so onCursorMove
     *  can hit-test without re-scanning the text on every cursor tick. */
    displaySpans: DisplaySpan[];
    checkedText: string;
    checkSeq: number;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    extmarkTypeId: number | null;
    activeExtmarkIds: number[];
    /** Non-null while a rephrase is in-flight or showing a result card. */
    rephrase: RephraseState | null;
}

function emptyRefState(): RefState {
    return {
        items: [],
        displaySpans: [],
        checkedText: "",
        checkSeq: 0,
        debounceTimer: null,
        extmarkTypeId: null,
        activeExtmarkIds: [],
        rephrase: null,
    };
}

/** Test-only injection seam. Production callers leave this undefined; the
 *  orchestrator then uses `client.correct` against the real bridge. Tests
 *  inject a deferred `correct` so they can swap the prompt ref mid-flight
 *  and exercise the stale-fetch race guard. */
export interface OrchestratorDeps {
    correct?: (req: CorrectRequest) => Promise<CorrectResponse>;
    /** Rephrase injection seam — mirrors `correct?`. Production callers
     *  leave undefined; the orchestrator defaults to client.rephrase.
     *  Tests inject a deferred stub to exercise the stale-seq guard. */
    rephrase?: (req: RephraseRequest) => Promise<RephraseResponse>;
    /**
     * Details-panel controller factory. Returns a PanelController whose
     * setView pushes pin/unpin transitions into a solid signal that
     * the JSX PanelComponent (in tui-entry.tsx) reads directly via
     * `view()`. The orchestrator uses ONLY setView (the bridge); the
     * render path is owned by tui-entry.tsx (single registration).
     * The production plugin entry (clients/opencode/src/tui-entry.tsx)
     * provides the real factory that wraps details-controller's
     * signal holder; tests pass a stub. Injecting here keeps the
     * @opentui/solid → @opentui/core → bun-ffi import graph out of
     * the test path (vitest runs under Node, not Bun).
     */
    panelRenderer?: () => PanelController;
}

/** Minimal shape of the item the panel needs to build its view-model.
 *  Matches the bridge's RenderableItem; kept inline (not imported from
 *  @/lib/pipeline) to avoid the panel module pulling pipeline code. */
export interface PanelItemInput {
    category: string;
    original: string;
    replacement: string;
}

// PanelController and PanelView are imported from details-panel-view.ts
// (the canonical source). Re-export so callers that import from
// orchestrator.ts still get the type.
export type { PanelController, PanelView };

export function startOrchestrator(
    api: TuiApi,
    options: Record<string, unknown> | undefined,
    deps?: OrchestratorDeps,
): () => void {
    // Unpatched OpenCode build (no prompt facade): warn once, return no-op.
    if (!api.prompt) {
        logDebug("feature-detect: api.prompt missing — plugin disabled", {});
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
    const rephraseFn = deps?.rephrase ?? ((req: RephraseRequest) => client.rephrase(req));

    // Style id cache: category → styleId. Lazy; one registerStyle per
    // category the first time we see it.
    const styleIds = new Map<string, number>();
    const getStyleId = (category: string): number | null => {
        if (styleIds.has(category)) return styleIds.get(category) ?? null;
        const syntax = api.theme.syntax?.();
        if (!syntax) return null;
        const id = syntax.registerStyle(`extmark.grammarforge.${category}`, {
            underline: true,
            fg: (CATEGORY_FG as Record<string, string>)[category] ?? CATEGORY_FG.unknown,
        });
        styleIds.set(category, id);
        return id;
    };

    let trackedRef: PromptRef | null = null;
    const state: RefState = emptyRefState();
    // Pin-state for the suggestion-details panel. Always created (the
    // toast path needs it on every state transition) but its
    // interactive commands (apply/ignore/cycle/unpin) are only wired
    // when the cursor facade is present.
    const detailsState: DetailsState = createDetailsState();

    // Feature-detect via the extracted helper (see feature-detect.ts).
    // One log line at startup captures the entire gate state for the
    // next live run to inspect. This is the PRIME SUSPECT for the
    // "no pin after click" symptom: if supported is false, the entire
    // pin wiring is skipped at startup.
    const pinSupport = detectPromptPinSupport(api);
    logDebug("feature-detect", {
        hasPrompt: pinSupport.hasPrompt,
        hasCursorChange: pinSupport.hasCursorChange,
        hasCursorOffset: pinSupport.hasCursorOffset,
        supported: pinSupport.supported,
        skipReason: pinSupport.supported
            ? null
            : !pinSupport.hasCursorChange
              ? "api.prompt.onCursorChange is not a function — pin wiring will not be installed"
              : !pinSupport.hasCursorOffset
                ? "ref.cursorOffset is not a number — pin wiring will not be installed"
                : "api.prompt is missing — plugin disabled (see unpatched-build toast)",
    });
    const cursorPinSupported = pinSupport.supported;

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
        if (state.extmarkTypeId === null) {
            state.extmarkTypeId = ref.extmarks.registerType("grammarforge");
        }
        const partRanges = collectPartRanges(ref.current.parts);
        // Use precomputed display spans (state.displaySpans, parallel to items).
        // These were computed once at check-complete; no re-scan needed here.
        const decorations = suggestionsToDecorations(state.displaySpans, items, partRanges);
        const typeId = state.extmarkTypeId;
        for (const d of decorations) {
            const styleId = getStyleId(d.category);
            if (styleId === null) continue;
            const id = ref.extmarks.create({
                start: d.start,
                end: d.end,
                virtual: false,
                styleId,
                typeId,
            });
            state.activeExtmarkIds.push(id);
        }
        // Log every rendered decoration so the next live run can
        // diff: (a) "do underlines actually appear at all?" and
        // (b) "what's the exact display span we hit-test against?".
        // Smoking-gun: if `count === 0` here while items.length > 0,
        // the partRanges/decorations filter dropped everything.
        logDebug("render decorations", {
            textLength: ref.text.length,
            itemCount: items.length,
            decorationCount: decorations.length,
            decorations: decorations.map((d) => {
                const it = items[d.itemIndex];
                return {
                    start: d.start,
                    end: d.end,
                    category: d.category,
                    itemIndex: d.itemIndex,
                    original: it?.original,
                    replacement: it?.replacements?.[0],
                };
            }),
        });
    };

    const runCheck = async (ref: PromptRef): Promise<void> => {
        const text = ref.text;
        logDebug("check start", { textLength: text.length, seq: state.checkSeq + 1 });
        if (text === "") {
            state.items = [];
            state.displaySpans = [];
            state.checkedText = "";
            clearActiveExtmarks();
            detailsState.itemsChanged(0);
            logDebug("check empty (empty buffer, no suggestions)", {});
            return;
        }
        // Mask paste placeholders so the bridge sees neutral whitespace instead
        // of placeholder tokens like "[Pasted ~5 lines]". Equal-length replacement
        // preserves all downstream offsets — no remapping needed. ONLY bridgeText
        // is sent to the bridge; everything else (stale guard, buildRenderableItems,
        // display spans, decorations) uses the original `text`.
        const parts = ref.current?.parts ?? [];
        const bridgeText = maskPastePlaceholders(text, parts);
        if (bridgeText.length !== text.length) {
            // Invariant: maskPastePlaceholders must return equal-length output.
            // This branch should never be reached; it is a defensive assertion.
            logDebug("paste mask length mismatch (bug — using original text)", {
                origLen: text.length,
                maskedLen: bridgeText.length,
            });
        }
        if (bridgeText !== text) {
            logDebug("paste mask applied", {
                maskedRanges: parts.filter((p) => p.type === "text" && p.source?.text?.value)
                    .length,
                origLen: text.length,
            });
        }
        const seq = ++state.checkSeq;
        try {
            const res = await correctFn({
                text: bridgeText.length === text.length ? bridgeText : text,
                source: SIGNAL_SOURCE,
            });
            // Stale-seq guard: the ref-swap path bumps state.checkSeq to
            // invalidate every in-flight check against the OLD ref.
            if (seq !== state.checkSeq) {
                logDebug("check dropped (stale seq)", { seq });
                return;
            }
            const liveRef = api.prompt?.ref();
            if (liveRef !== ref) {
                logDebug("check dropped (liveRef !== captured ref)", {});
                return;
            }
            if (ref !== trackedRef) {
                logDebug("check dropped (ref !== trackedRef)", {});
                return;
            }
            if (ref.text !== text) {
                logDebug("check dropped (text drifted)", {});
                return;
            }
            const builtItems = buildRenderableItems(text, res).items;
            state.items = builtItems;
            state.checkedText = text;
            // Compute display spans ONCE here — O(text + items·log text) — so
            // onCursorMove can hit-test from the cache without re-scanning.
            state.displaySpans = displaySpansForItems(
                text,
                builtItems.map((it) => ({ start: it.hlStart, end: it.hlEnd })),
                displayWidthOf,
            );
            logDebug("check complete", {
                suggestionCount: res.suggestions?.length ?? 0,
                itemCount: builtItems.length,
                items: builtItems.map((it) => ({
                    category: it.category,
                    original: it.original,
                    replacement: it.replacements?.[0],
                    cuStart: it.cuStart,
                    cuEnd: it.cuEnd,
                })),
            });
            renderDecorations(ref, state.items);
            // Identity-swap detection (secondary): if items.count is the
            // same as before but the pinned item's (hlStart, hlEnd,
            // replacement) signature changed, the pin is now stale —
            // unpin. The count-only check in itemsChanged would miss
            // this. Read the prior items list from the itemsChanged
            // path; detailsState.itemsChanged takes the new count but
            // also gets a "signature" snapshot for the identity check.
            detailsState.itemsChanged(state.items.length, state.items.map(snapshotOfItem));
        } catch (e) {
            // Bridge unreachable / errored: silent idle, retry on the next change.
            logDebug("check errored", {
                message: e instanceof Error ? e.message : String(e),
            });
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
        if (ref !== trackedRef) {
            clearActiveExtmarks();
            state.checkSeq += 1;
            state.extmarkTypeId = null;
            trackedRef = ref;
            state.items = [];
            state.displaySpans = [];
            state.checkedText = "";
            detailsState.itemsChanged(0);
            // Cancel any in-flight or showing rephrase — it was for the old ref.
            if (state.rephrase !== null) {
                rephraseSeq++;
                stopSpinner();
                state.rephrase = null;
                const ctrl = rephraseController;
                if (ctrl) ctrl.setView(null);
            }
        }
        const text = ref.text;
        if (text === "" && state.items.length > 0 && state.checkedText !== "") {
            for (const it of state.items) {
                if (typeof it.id !== "number") continue;
                const ev: SignalEvent = { id: it.id, action: "ignored", source: SIGNAL_SOURCE };
                signalQueue.enqueue(ev);
            }
            void signalQueue.flush();
            state.items = [];
            state.displaySpans = [];
            state.checkedText = "";
            clearActiveExtmarks();
            detailsState.itemsChanged(0);
            return;
        }
        scheduleCheck(ref);
    };

    const applyAll = (): void => {
        if (state.items.length === 0) return;
        // Sort a copy descending by cuStart so higher-offset edits apply
        // first and never shift lower-offset spans.
        const sorted = [...state.items].sort((a, b) => b.cuStart - a.cuStart);
        let count = 0;
        for (const item of sorted) {
            // Re-read live ref each iteration — replaceRange is synchronous
            // and the text object may be updated in place.
            const live = api.prompt?.ref();
            if (!live) break;
            if (!isSpanStillValid(live.text, item)) continue;
            const ds = displaySpanFromCodeUnits(
                live.text,
                { start: item.cuStart, end: item.cuEnd },
                displayWidthOf,
            );
            const replacement = item.replacements[0] ?? "";
            live.replaceRange(ds.start, ds.end, replacement);
            if (typeof item.id === "number") {
                const ev: SignalEvent = {
                    id: item.id,
                    action: "accepted",
                    category: item.category,
                    source: SIGNAL_SOURCE,
                };
                signalQueue.enqueue(ev);
            }
            count++;
        }
        if (count > 0) {
            api.ui.toast({
                message: `Applied ${count} suggestion${count === 1 ? "" : "s"}`,
                variant: "success",
            });
        }
        // Clear stale underlines + state so the details card dismisses
        // immediately and the next onChange-scheduled re-check rebuilds
        // on the edited text. Do NOT call renderDecorations here —
        // spans are stale after the edit.
        detailsState.unpin();
        clearActiveExtmarks();
        state.items = [];
        state.displaySpans = [];
        state.checkedText = "";
        detailsState.itemsChanged(0);
        onChange();
    };

    const unsubscribeChange = api.prompt.onChange(onChange);

    // ─── Rephrase state machine ───────────────────────────────────────────────
    // rephraseSeq: monotonic counter — bumped on each new rephrase + on reject.
    // spinnerTimer: drives the loading animation by pushing setView() on a timer.
    // The orchestrator owns the timer (NOT the component) per the render-reactivity
    // constraint: only controller.setView() → PanelComponent's local signal drives
    // re-renders. An in-component setInterval would queue updates that never flush.
    let rephraseSeq = 0;
    let spinnerTimer: ReturnType<typeof setInterval> | null = null;

    // Helper: get the panel controller if available (injected via panelRenderer).
    // We need it for rephrase setView calls outside the detailsState subscription.
    let rephraseController: PanelController | null = null;

    const stopSpinner = (): void => {
        if (spinnerTimer !== null) {
            clearInterval(spinnerTimer);
            spinnerTimer = null;
        }
    };

    const rephrase = (): void => {
        const ref = api.prompt?.ref();
        if (!ref) return;
        const text = ref.text;
        if (!text.trim()) {
            api.ui.toast({ message: "Nothing to rephrase", variant: "info" });
            return;
        }
        logDebug("rephrase start", { textLen: text.length });
        // Clear any suggestion pin so the suggestion card doesn't fight the rephrase card.
        detailsState.unpin();
        clearActiveExtmarks();
        const seq = ++rephraseSeq;
        state.rephrase = { mode: "loading", original: text, seq, ref };
        let frame = 0;
        const ctrl = rephraseController;
        if (ctrl) {
            ctrl.setView({ kind: "rephrase-loading", frame, displayStart: 0 });
        }
        stopSpinner();
        spinnerTimer = setInterval(() => {
            frame++;
            if (state.rephrase?.mode === "loading" && state.rephrase.seq === seq && ctrl) {
                ctrl.setView({ kind: "rephrase-loading", frame, displayStart: 0 });
            }
        }, 100);
        void (async () => {
            try {
                const res = await rephraseFn({ text, source: SIGNAL_SOURCE });
                // Belt-and-suspenders: drop if seq stale OR the live ref no longer
                // matches the captured ref (onChange ref-swap normally already cleared
                // state.rephrase, but this guard handles any ordering where onChange
                // hasn't fired yet and ensures the spinner can't linger).
                const liveRef = api.prompt?.ref();
                if (state.rephrase?.seq !== seq) {
                    // Superseded by a newer rephrase — do NOT stopSpinner (that timer belongs to the newer one).
                    logDebug("rephrase cancelled (stale seq)", {});
                    return;
                }
                if (liveRef !== ref) {
                    // Our rephrase, but the prompt ref swapped before onChange cancelled us — fully cancel.
                    logDebug("rephrase cancelled (ref swap)", {});
                    stopSpinner();
                    state.rephrase = null;
                    const ctrl = rephraseController;
                    if (ctrl) ctrl.setView(null);
                    return;
                }
                stopSpinner();
                const rephrased = res.rephrased ?? "";
                if (!rephrased || rephrased === text) {
                    state.rephrase = null;
                    if (ctrl) ctrl.setView(null);
                    api.ui.toast({
                        message: rephrased === text ? "No changes suggested" : "Rephrase empty",
                        variant: "info",
                    });
                    return;
                }
                logDebug("rephrase result", { origLen: text.length, newLen: rephrased.length });
                state.rephrase = { mode: "result", original: text, rephrased, seq, ref };
                if (ctrl) {
                    ctrl.setView({
                        kind: "rephrase-result",
                        original: text,
                        rephrased,
                        displayStart: 0,
                    });
                }
            } catch (e) {
                if (state.rephrase?.seq === seq) {
                    stopSpinner();
                    state.rephrase = null;
                    if (ctrl) ctrl.setView(null);
                    api.ui.toast({ message: "Rephrase failed", variant: "error" });
                }
                logDebug("rephrase error", { message: e instanceof Error ? e.message : String(e) });
            }
        })();
    };

    const rephraseAccept = (): void => {
        if (state.rephrase?.mode !== "result") return;
        const ctrl = rephraseController;
        const ref = api.prompt?.ref();
        if (!ref) {
            state.rephrase = null;
            if (ctrl) ctrl.setView(null);
            return;
        }
        // Ref-identity check: if the prompt ref swapped (route remount) since
        // the rephrase started, discard — we must not apply to the new ref even
        // if its text happens to match the original.
        if (ref !== state.rephrase.ref) {
            api.ui.toast({ message: "Prompt changed; rephrase discarded", variant: "info" });
            state.rephrase = null;
            if (ctrl) ctrl.setView(null);
            return;
        }
        if (ref.text !== state.rephrase.original) {
            api.ui.toast({ message: "Prompt changed; rephrase discarded", variant: "info" });
            state.rephrase = null;
            if (ctrl) ctrl.setView(null);
            return;
        }
        const rephrased = state.rephrase.rephrased ?? "";
        const end = displayWidthOf(ref.text);
        ref.replaceRange(0, end, rephrased);
        state.rephrase = null;
        if (ctrl) ctrl.setView(null);
        stopSpinner();
        onChange();
        api.ui.toast({ message: "Rephrased", variant: "success" });
    };

    const rephraseReject = (): void => {
        rephraseSeq++; // invalidate any in-flight request
        stopSpinner();
        state.rephrase = null;
        const ctrl = rephraseController;
        if (ctrl) ctrl.setView(null);
    };

    // Apply-all + rephrase layer — always on, no gate.
    const disposeAcceptLayer = api.keymap.registerLayer({
        priority: 500,
        commands: [
            {
                name: "grammarforge.applyAll",
                title: "GrammarForge: apply all suggestions",
                run: applyAll,
            },
            {
                name: "grammarforge.rephrase",
                title: "GrammarForge: rephrase prompt",
                run: rephrase,
            },
        ],
        bindings: [
            { key: settings.applyAllHotkey, cmd: "grammarforge.applyAll" },
            { key: settings.rephraseHotkey, cmd: "grammarforge.rephrase" },
        ],
    });

    // Rephrase result/loading layer — gated: active whenever state.rephrase !== null.
    // enter accepts (no-op if still loading), esc cancels in both modes.
    const disposeRephraseLayer = api.keymap.registerLayer({
        priority: 500,
        enabled: () => state.rephrase !== null,
        commands: [
            {
                name: "grammarforge.rephrase.accept",
                title: "GrammarForge: accept rephrase",
                run: rephraseAccept,
            },
            {
                name: "grammarforge.rephrase.reject",
                title: "GrammarForge: reject rephrase",
                run: rephraseReject,
            },
        ],
        bindings: [
            { key: "return", cmd: "grammarforge.rephrase.accept" },
            { key: "escape", cmd: "grammarforge.rephrase.reject" },
        ],
    });

    // Details layer — gated by enabled. When nothing is pinned, the
    // host keymap does not dispatch any of the layer's bindings, so
    // return/x/cycleNext/cyclePrev/escape stay free for the host's own
    // behavior. When a pin exists, the bindings become active.
    let disposeDetailsLayer: (() => void) | null = null;
    if (cursorPinSupported) {
        logDebug("details keymap layer: registered", {
            commands: [
                "grammarforge.details.apply",
                "grammarforge.details.ignore",
                "grammarforge.details.cycleNext",
                "grammarforge.details.cyclePrev",
                "grammarforge.details.unpin",
            ],
            bindings: ["return", "x", settings.cycleNextHotkey, settings.cyclePrevHotkey, "escape"],
            enabled: () => detailsState.pinnedIndex() !== null,
        });
        const applyPinned = (): void => {
            logDebug("keymap: applyPinned invoked", {
                pinnedIndex: detailsState.pinnedIndex(),
            });
            const ref = api.prompt?.ref();
            if (!ref) return;
            const pinIndex = detailsState.pinnedIndex();
            if (pinIndex === null) return;
            if (pinIndex >= state.items.length) return;
            const item = state.items[pinIndex]!;
            if (!isSpanStillValid(ref.text, item)) {
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
            api.ui.toast({
                message: `Applied: ${replacement || item.original}`,
                variant: "success",
            });
            // Clear stale underlines + state so the details card dismisses
            // immediately and the next onChange-scheduled re-check rebuilds
            // on the edited text. Do NOT call renderDecorations here —
            // spans are stale after the edit.
            detailsState.unpin();
            clearActiveExtmarks();
            state.items = [];
            state.displaySpans = [];
            state.checkedText = "";
            detailsState.itemsChanged(0);
            onChange();
        };
        const ignorePinned = (): void => {
            const ref = api.prompt?.ref();
            const pinIndex = detailsState.pinnedIndex();
            logDebug("keymap: ignorePinned invoked", { pinnedIndex: pinIndex });
            if (pinIndex === null) return;
            if (pinIndex >= state.items.length) return;
            const item = state.items[pinIndex]!;
            if (typeof item.id === "number") {
                const ev: SignalEvent = {
                    id: item.id,
                    action: "ignored",
                    source: SIGNAL_SOURCE,
                };
                signalQueue.enqueue(ev);
            }
            // BLOCKER 3 FIX: drop the item AND re-render decorations. The
            // previous version left a stale underline because it only
            // mutated state.items. Now we clear the active extmarks
            // and re-render against the reduced item set. If the live
            // ref is present, do a full render; otherwise just clear
            // (the next onChange will resync).
            state.items = state.items.filter((_, i) => i !== pinIndex);
            state.displaySpans = state.displaySpans.filter((_, i) => i !== pinIndex);
            detailsState.unpin();
            if (ref) {
                renderDecorations(ref, state.items);
                detailsState.itemsChanged(state.items.length, state.items.map(snapshotOfItem));
            } else {
                clearActiveExtmarks();
                detailsState.itemsChanged(0);
            }
        };
        const cycleNext = (): void => {
            logDebug("keymap: cycleNext invoked", {
                pinnedIndex: detailsState.pinnedIndex(),
                itemCount: state.items.length,
            });
            detailsState.cycle(1, state.items.length);
            const idx = detailsState.pinnedIndex();
            if (idx !== null && state.displaySpans[idx] !== undefined) {
                logDebug("cycle moved cursor", {
                    index: idx,
                    offset: state.displaySpans[idx]?.start,
                });
                api.prompt?.ref()?.setCursorOffset?.(state.displaySpans[idx]!.start);
            }
        };
        const cyclePrev = (): void => {
            logDebug("keymap: cyclePrev invoked", {
                pinnedIndex: detailsState.pinnedIndex(),
                itemCount: state.items.length,
            });
            detailsState.cycle(-1, state.items.length);
            const idx = detailsState.pinnedIndex();
            if (idx !== null && state.displaySpans[idx] !== undefined) {
                logDebug("cycle moved cursor", {
                    index: idx,
                    offset: state.displaySpans[idx]?.start,
                });
                api.prompt?.ref()?.setCursorOffset?.(state.displaySpans[idx]!.start);
            }
        };
        const unpin = (): void => {
            logDebug("keymap: unpin invoked", { pinnedIndex: detailsState.pinnedIndex() });
            detailsState.unpin();
        };
        disposeDetailsLayer = api.keymap.registerLayer({
            priority: 500,
            enabled: () => detailsState.pinnedIndex() !== null,
            commands: [
                {
                    name: "grammarforge.details.apply",
                    title: "GrammarForge: apply pinned suggestion",
                    run: applyPinned,
                },
                {
                    name: "grammarforge.details.ignore",
                    title: "GrammarForge: ignore pinned suggestion",
                    run: ignorePinned,
                },
                {
                    name: "grammarforge.details.cycleNext",
                    title: "GrammarForge: next suggestion",
                    run: cycleNext,
                },
                {
                    name: "grammarforge.details.cyclePrev",
                    title: "GrammarForge: previous suggestion",
                    run: cyclePrev,
                },
                {
                    name: "grammarforge.details.unpin",
                    title: "GrammarForge: close details panel",
                    run: unpin,
                },
            ],
            bindings: [
                { key: "return", cmd: "grammarforge.details.apply" },
                { key: "x", cmd: "grammarforge.details.ignore" },
                { key: settings.cycleNextHotkey, cmd: "grammarforge.details.cycleNext" },
                { key: settings.cyclePrevHotkey, cmd: "grammarforge.details.cyclePrev" },
                { key: "escape", cmd: "grammarforge.details.unpin" },
            ],
        });
    }

    // Cursor-pin wiring: subscribe to onCursorChange, hit-test the
    // cursor against the current items' display spans, and pin the
    // matching item. Cursor-OUTSIDE any span is an explicit no-op
    // (only esc/stale/apply/ignore/cycle clear — explicit design).
    let unsubscribeCursorChange: (() => void) | null = null;
    if (cursorPinSupported) {
        const onCursorMove = (): void => {
            const ref = api.prompt?.ref();
            if (!ref) {
                logDebug("onCursorChange: no live ref", {});
                return;
            }
            // Rephrase suppression: during rephrase (loading or result), cursor
            // moves must NOT pin/unpin suggestions — they'd clobber the rephrase card.
            if (state.rephrase !== null) return;
            const offset = ref.cursorOffset;
            // THE smoking-gun log: every onCursorChange fire logs the
            // raw offset. If this never logs after a click, the
            // facade subscription is the bug (or the onCursorChange
            // registration was overwritten by another subscriber).
            if (typeof offset !== "number") {
                logDebug("onCursorChange: cursorOffset not a number", { value: offset });
                return;
            }
            if (state.items.length === 0) {
                logDebug("onCursorChange: items empty (no hit-test candidates)", { offset });
                return;
            }
            // Stale guard: state.displaySpans/items are for checkedText.
            // If the user typed since the last check, ref.text has drifted —
            // hit-testing cached spans against new text is wrong, so skip.
            if (ref.text !== state.checkedText) {
                logDebug("onCursorChange: text drifted from checkedText", {});
                return;
            }
            // Build the candidate span list from the CACHED display spans
            // (computed once at check-complete). No Segmenter re-scan here.
            const candidateSpans: Array<{
                index: number;
                category: string;
                hlStart: number;
                hlEnd: number;
                displayStart: number;
                displayEnd: number;
            }> = [];
            for (let i = 0; i < state.items.length; i++) {
                const it = state.items[i]!;
                const span = state.displaySpans[i] ?? { start: 0, end: 0 };
                candidateSpans.push({
                    index: i,
                    category: it.category,
                    hlStart: it.hlStart,
                    hlEnd: it.hlEnd,
                    displayStart: span.start,
                    displayEnd: span.end,
                });
            }
            let matchIndex: number | null = null;
            for (let i = 0; i < candidateSpans.length; i++) {
                const cs = candidateSpans[i]!;
                // END-INCLUSIVE. Pre-fix used < (end-exclusive) which
                // rejected word-end clicks: offset 14 vs span [8,14)
                // returned no match. End-inclusive pins the word-end
                // click. See hit-test.ts for the unit-tested contract.
                if (offset >= cs.displayStart && offset <= cs.displayEnd) {
                    matchIndex = i;
                    break;
                }
            }
            logDebug("hit-test", {
                offset,
                textLength: ref.text.length,
                candidateCount: candidateSpans.length,
                match: matchIndex === null ? "no match" : `index ${matchIndex}`,
                candidates: candidateSpans,
            });
            if (matchIndex !== null) {
                const it = state.items[matchIndex]!;
                logDebug("pin transition", {
                    index: matchIndex,
                    category: it.category,
                    offset,
                });
                detailsState.pin(matchIndex);
            } else {
                logDebug("cursor off all suggestions — unpin", { offset });
                detailsState.unpin();
            }
        };
        unsubscribeCursorChange = api.prompt.onCursorChange!(onCursorMove);
        logDebug("onCursorChange subscription installed", {});
    }

    // Slot-panel wiring (RESTORED from d6cb2d2's descope). The render
    // fn is supplied by the plugin entry via deps.panelRenderer — see
    // the OrchestratorDeps docstring. The controller factory closes over
    // its own solid signal; we just push transitions into it from
    // detailsState.subscribe and let the JSX PanelComponent (in
    // tui-entry.tsx) read the signal directly via controller.view().
    // The orchestrator does NOT register slots or render anything —
    // the single registration lives in tui-entry.tsx (verified via
    // `grep -rn "api.slots.register" src/` — exactly one hit).
    // This avoids the dual-registration bug that caused the host to
    // receive two slot plugins for the same names.
    let unsubscribeDetailsTransition: (() => void) | null = null;
    if (cursorPinSupported && deps?.panelRenderer) {
        const controller = deps.panelRenderer();
        // Wire the rephrase controller reference so the rephrase state machine
        // can call controller.setView() for loading/result cards.
        rephraseController = controller;
        // The transition push: build the current panel payload and
        // hand it to the controller's setter. The setter is what
        // updates the solid signal that PanelComponent reads via
        // controller.view().
        const pushFromDetailsState = (): void => {
            const index = detailsState.pinnedIndex();
            if (index === null || index >= state.items.length) {
                logDebug("unpin transition", { from: index });
                controller.setView(null);
                return;
            }
            const item = state.items[index]!;
            // Compute the display-start offset for the overlay anchor.
            // We need the live ref text to convert code-unit span to
            // display-width offset. If the ref is gone, fall back to 0
            // (the overlay will still render, just at column 0).
            const liveRef = api.prompt?.ref();
            const displaySpan = liveRef
                ? displaySpanFromCodeUnits(
                      liveRef.text,
                      { start: item.hlStart, end: item.hlEnd },
                      displayWidthOf,
                  )
                : { start: 0, end: 0 };
            logDebug("panel content transition", {
                index,
                total: state.items.length,
                category: item.category,
                displayStart: displaySpan.start,
            });
            controller.setView({
                kind: "suggestion",
                item: {
                    category: item.category,
                    original: item.diffOriginal,
                    replacement: item.diffCorrected,
                    isDeletion: item.diffIsDeletion,
                },
                index,
                total: state.items.length,
                displayStart: displaySpan.start,
                cycleNextKey: settings.cycleNextHotkey,
                cyclePrevKey: settings.cyclePrevHotkey,
            });
        };
        unsubscribeDetailsTransition = detailsState.subscribe(pushFromDetailsState);
    }

    const onDispose = api.lifecycle.onDispose(() => {
        // Lifecycle owns its own teardown chain; nothing extra to do here.
    });

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
        stopSpinner();
        state.rephrase = null;
        unsubscribeChange();
        if (unsubscribeDetailsTransition) unsubscribeDetailsTransition();
        if (unsubscribeCursorChange) unsubscribeCursorChange();
        disposeAcceptLayer();
        disposeRephraseLayer();
        if (disposeDetailsLayer) disposeDetailsLayer();
        onDispose();
        clearActiveExtmarks();
        void signalQueue.flush();
    };
}

/** Compact identity signature for the secondary identity-swap check on
 *  itemsChanged. Same length as the items array; indexed by position.
 *  Used to detect "items count is the same but the pinned item's
 *  (hlStart, hlEnd, replacement) changed" — a re-check that produced
 *  different content for the same indices. */
function snapshotOfItem(item: RenderableItem): string {
    return `${item.hlStart}:${item.hlEnd}:${item.replacements[0] ?? ""}`;
}
