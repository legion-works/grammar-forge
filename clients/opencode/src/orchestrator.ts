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
    CompleteRequest,
    CompleteResponse,
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
import { buildStatusLine } from "./status-line";
import { joinContinuation, lineLooksUnfinished, type GhostRenderer } from "./ghost-overlay";
import { CATEGORY_FG } from "./category-palette";
import type { PromptRef, TuiApi } from "./opencode-types";
import type { PanelController, PanelView } from "./details-panel-view";

const SIGNAL_SOURCE = "opencode";

const DEFAULT_APPLY_ALL_HOTKEY = "ctrl+.";
const DEFAULT_CYCLE_NEXT_HOTKEY = "ctrl+n";
const DEFAULT_CYCLE_PREV_HOTKEY = "ctrl+p";
const DEFAULT_REPHRASE_HOTKEY = "ctrl+/";
const DEFAULT_COMPLETION_ENABLED = false;
const DEFAULT_COMPLETION_DEBOUNCE_MS = 600;
const DEFAULT_NEXT_ISSUE_HOTKEY = "ctrl+g";
const DEFAULT_PREV_ISSUE_HOTKEY = "ctrl+shift+g";

export interface GrammarForgeSettings {
    bridgeUrl: string;
    realtimeDelayMs: number;
    applyAllHotkey: string;
    cycleNextHotkey: string;
    cyclePrevHotkey: string;
    rephraseHotkey: string;
    nextIssueHotkey: string;
    prevIssueHotkey: string;
    allowRemoteBridge: boolean;
    /** Enable Copilot-style inline ghost-text completion. Default false
     *  (opt-in — the bridge /complete endpoint is also default-off). */
    completionEnabled: boolean;
    /** Debounce delay in ms before a completion request fires on pause.
     *  Separate from realtimeDelayMs (the grammar re-check debounce). */
    completionDebounceMs: number;
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
    const nextIssueHotkeyRaw =
        typeof raw.nextIssueHotkey === "string" ? raw.nextIssueHotkey.trim().toLowerCase() : "";
    const nextIssueHotkey =
        nextIssueHotkeyRaw === "" ? DEFAULT_NEXT_ISSUE_HOTKEY : nextIssueHotkeyRaw;
    const prevIssueHotkeyRaw =
        typeof raw.prevIssueHotkey === "string" ? raw.prevIssueHotkey.trim().toLowerCase() : "";
    const prevIssueHotkey =
        prevIssueHotkeyRaw === "" ? DEFAULT_PREV_ISSUE_HOTKEY : prevIssueHotkeyRaw;
    const completionEnabled =
        typeof raw.completionEnabled === "boolean" ? raw.completionEnabled : DEFAULT_COMPLETION_ENABLED;
    const completionDebounceMsRaw =
        typeof raw.completionDebounceMs === "number" ? raw.completionDebounceMs : NaN;
    const completionDebounceMs =
        Number.isFinite(completionDebounceMsRaw) && completionDebounceMsRaw > 0
            ? completionDebounceMsRaw
            : DEFAULT_COMPLETION_DEBOUNCE_MS;
    return {
        bridgeUrl: common.bridgeUrl,
        realtimeDelayMs: common.realtimeDelayMs,
        applyAllHotkey,
        cycleNextHotkey,
        cyclePrevHotkey,
        rephraseHotkey,
        nextIssueHotkey,
        prevIssueHotkey,
        allowRemoteBridge: common.allowRemoteBridge,
        completionEnabled,
        completionDebounceMs,
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
    alternatives: string[];   // NEW: all variants (primary index 0 = rephrased)
    altIndex: number;         // NEW: which alternative is currently shown (0 = primary)
    scrollOffset: number;     // NEW: line scroll offset for tall rephrase cards (A4)
    /** Monotonic sequence number — incremented on each new rephrase
     *  invocation and on reject/cancel. In-flight async callbacks
     *  compare against this to detect stale results. */
    seq: number;
    /** The prompt ref that was active when this rephrase started.
     *  Used to detect ref swaps (route remounts) and discard stale
     *  results that arrived for a different prompt instance. */
    ref: PromptRef;
}

interface CompletionState {
    /** Monotonic counter bumped on each new completion request; stale-seq guard. */
    seq: number;
    /** The continuation text returned by the bridge. Non-empty while a ghost is visible. */
    continuation: string;
    /** The prompt ref captured at request time (ref-identity guard). */
    ref: PromptRef;
    /** The cursor offset at request time so the ghost anchor is fixed. */
    atOffset: number;
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
    /** Non-null while a completion ghost is visible. */
    completion: CompletionState | null;
    /** Separate debounce timer for the completion pause detector. */
    completionTimer: ReturnType<typeof setTimeout> | null;
}

interface JumpResult {
    pinIndex: number;
    cursorOffset: number;
}

/**
 * Find the next item after the cursor offset (end-exclusive search; wraps).
 * Returns null when there are no items.
 */
export function jumpNext(
    cursorOffset: number,
    items: Array<{ category?: string }>,
    displaySpans: Array<{ start: number; end: number }>,
): JumpResult | null {
    if (items.length === 0) return null;
    const ascending = items
        .map((_, i) => i)
        .sort((a, b) => (displaySpans[a]?.start ?? 0) - (displaySpans[b]?.start ?? 0));
    for (const idx of ascending) {
        const span = displaySpans[idx];
        if (!span) continue;
        // Item starts after the cursor → first match wins.
        if (span.start > cursorOffset) {
            return { pinIndex: idx, cursorOffset: span.start };
        }
    }
    // Wrap: return the first item (by display order).
    const firstIdx = ascending[0]!;
    return { pinIndex: firstIdx, cursorOffset: displaySpans[firstIdx]?.start ?? 0 };
}

/**
 * Find the previous item before the cursor offset (wraps to last).
 */
export function jumpPrev(
    cursorOffset: number,
    items: Array<{ category?: string }>,
    displaySpans: Array<{ start: number; end: number }>,
): JumpResult | null {
    if (items.length === 0) return null;
    const descending = items
        .map((_, i) => i)
        .sort((a, b) => (displaySpans[b]?.end ?? 0) - (displaySpans[a]?.end ?? 0));
    for (const idx of descending) {
        const span = displaySpans[idx];
        if (!span) continue;
        // Item ends before the cursor → first match wins.
        if (span.end < cursorOffset) {
            return { pinIndex: idx, cursorOffset: span.start };
        }
    }
    // Wrap: return the last item (by display order).
    const lastIdx = descending[0]!;
    return { pinIndex: lastIdx, cursorOffset: displaySpans[lastIdx]?.start ?? 0 };
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
        completion: null,
        completionTimer: null,
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
    /** Completion injection seam — mirrors `rephrase?`. Production
     *  callers leave undefined; the orchestrator defaults to
     *  client.complete. Tests inject a deferred stub. */
    complete?: (req: CompleteRequest) => Promise<CompleteResponse>;
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
    /** Ghost text render controller — Path A self-render, wired by
     *  tui-entry.tsx. Path B swaps to promptRef.ghostText at one call-site. */
    ghostRenderer?: GhostRenderer;
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
    const completeFn = deps?.complete ?? ((req: CompleteRequest) => client.complete(req));

    // Ghost render callback — wired by tui-entry.tsx via deps.ghostRenderer.
    // Path A: self-render overlay. Path B: one-line swap to promptRef.ghostText.
    // See ghost-overlay.ts for the render interface.
    const renderGhost = (text: string, atOffset: number): void => {
        deps?.ghostRenderer?.renderGhost(text, atOffset);
    };
    const clearGhost = (): void => {
        deps?.ghostRenderer?.clearGhost();
    };

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
            pushStatusLine();
            logDebug("check empty (empty buffer, no suggestions)", {});
            return;
        }
        // Skip the bridge round-trip when the text is identical to what we last
        // checked — items/displaySpans/decorations are already valid for it.
        // This fires when an edit returns the buffer to a previously-checked
        // value (e.g. type a char then backspace it), which would otherwise
        // re-hit /correct redundantly. Safe because EVERY path that clears the
        // decorations also resets checkedText to "" (ref-swap, empty buffer,
        // apply), so a non-empty checkedText === text guarantees live state.
        if (text === state.checkedText) {
            logDebug("check skipped (text unchanged since last check)", {});
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
            pushStatusLine();
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
        // DIAG (gated): every onChange entry. A flood here = the host is
        // re-firing onChange in a loop (e.g. an edit/decoration feedback).
        logDebug("onChange entered", {
            textLen: ref.text.length,
            tracked: ref === trackedRef,
            itemCount: state.items.length,
        });

        // ── A8: Eager dismiss on edit ──────────────────────────────────
        // Clear the active suggestion surfaces IMMEDIATELY — before the
        // debounced re-check resolves. Never show a stale suggestion
        // while the user is actively editing.
        const textChanged = ref.text !== state.checkedText;
        if (textChanged) {
            // Clear the pinned correction card.
            detailsState.unpin();
            // Clear any in-flight or showing rephrase.
            if (state.rephrase !== null) {
                rephraseSeq++;
                stopSpinner();
                state.rephrase = null;
                const ctrl = rephraseController;
                if (ctrl) ctrl.setView(null);
            }
            // NOTE: Underlines are NOT cleared here — they reconcile on
            // the debounced re-check (avoids flicker).
            // ── WS-C: Eagerly clear completion ghost on edit ──────
            if (state.completion !== null) {
                completionSeq++; // invalidate in-flight
                if (state.completionTimer !== null) {
                    clearTimeout(state.completionTimer);
                    state.completionTimer = null;
                }
                state.completion = null;
                clearGhost();
            }
            pushStatusLine();
        }

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
            // Clear completion ghost on ref-swap.
            if (state.completion !== null) {
                completionSeq++;
                if (state.completionTimer !== null) {
                    clearTimeout(state.completionTimer);
                    state.completionTimer = null;
                }
                state.completion = null;
                clearGhost();
            }
        }
        const text = ref.text;
        if (text === "") {
            // An empty buffer (cleared or submitted) must NEVER retain a
            // completion ghost/status. The eager-dismiss block above only fires
            // when textChanged, but on a FAST submit the ghost can be armed
            // before the grammar check recorded checkedText (the two debounces
            // are independent) — so checkedText is still "" → textChanged is
            // false → the eager-clear is skipped and the ghost goes stale,
            // surfacing as "completion ready" on an empty prompt. Clear it
            // unconditionally here; the canonical item/extmark/status teardown
            // still happens below (or in the debounced empty runCheck).
            if (clearCompletionGhost()) {
                // Refresh immediately so the stale "completion ready" status
                // blanks now, not 500ms later when the debounced check fires.
                pushStatusLine();
            }
        }
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
            // Refresh the status line — checkedText is now "" so this blanks the
            // stale "N issues" instead of leaving it on screen after the clear.
            pushStatusLine();
            return;
        }
        scheduleCheck(ref);

        // ── Completion pause detector ─────────────────────────────────
        // Separate debounce from the grammar re-check. Only fires when
        // completion is enabled, the line looks unfinished, and we are
        // NOT pinned or rephrasing (mutually exclusive states).
        if (state.completionTimer !== null) {
            clearTimeout(state.completionTimer);
            state.completionTimer = null;
        }
        if (
            settings.completionEnabled &&
            lineLooksUnfinished(text) &&
            (ref.cursorOffset ?? text.length) === text.length &&
            detailsState.pinnedIndex() === null &&
            state.rephrase === null
        ) {
            const capturedRef = ref;
            const capturedText = text;
            const capturedOffset = ref.cursorOffset ?? text.length;
            state.completionTimer = setTimeout(() => {
                state.completionTimer = null;
                void requestCompletion(capturedRef, capturedText, capturedOffset);
            }, settings.completionDebounceMs);
        }
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
    let completionSeq = 0;
    let spinnerTimer: ReturnType<typeof setInterval> | null = null;
    // 1-entry completion cache: the last (text → continuation) the bridge
    // returned. Serves an identical re-request from cache instead of re-hitting
    // /complete (the slow LLM endpoint) — fires e.g. when an edit returns the
    // buffer to a previously-completed value (type a char then backspace), or
    // when the user dismisses then the same line re-arms. Empty continuations
    // are NOT cached (so a transient empty result can be retried).
    let lastCompletionText: string | null = null;
    let lastCompletionResult: string | null = null;

    // Helper: get the panel controller if available (injected via panelRenderer).
    // We need it for rephrase setView calls outside the detailsState subscription.
    let rephraseController: PanelController | null = null;
    // A6: pushStatusLine is defined inside the controller block; holder ref
    // so runCheck + rephrase callbacks can call it.
    let pushStatusLine: () => void = () => undefined;

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
        state.rephrase = { mode: "loading", original: text, alternatives: [], altIndex: 0, scrollOffset: 0, seq, ref };
        pushStatusLine();
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
                const res = await rephraseFn({ text, source: SIGNAL_SOURCE, alternatives: 3 });
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
                const alternatives = (res.alternatives ?? []).filter(
                    (a) => a && a !== rephrased,
                );
                state.rephrase = {
                    mode: "result",
                    original: text,
                    rephrased,
                    alternatives,
                    altIndex: 0,
                    scrollOffset: 0,
                    seq,
                    ref,
                };
                if (ctrl) {
                    ctrl.setView({
                        kind: "rephrase-result",
                        original: text,
                        rephrased,
                        alternatives,
                        altIndex: 0,
                        altTotal: 1 + alternatives.length,
                        scrollOffset: 0,
                        displayStart: 0,
                    });
                    pushStatusLine();
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
        // Apply the SELECTED alternative, not always the primary.
        const rephrased =
            state.rephrase.altIndex === 0
                ? (state.rephrase.rephrased ?? "")
                : (state.rephrase.alternatives[state.rephrase.altIndex - 1] ?? "");
        const end = displayWidthOf(ref.text);
        ref.replaceRange(0, end, rephrased);
        state.rephrase = null;
        if (ctrl) ctrl.setView(null);
        stopSpinner();
        onChange();
        api.ui.toast({ message: "Rephrased", variant: "success" });
        pushStatusLine();
    };

    const rephraseReject = (): void => {
        rephraseSeq++; // invalidate any in-flight request
        stopSpinner();
        state.rephrase = null;
        const ctrl = rephraseController;
        if (ctrl) ctrl.setView(null);
        pushStatusLine();
    };

    // ── Completion state machine ──────────────────────────────────────────
    const requestCompletion = async (
        ref: PromptRef,
        text: string,
        atOffset: number,
    ): Promise<void> => {
        if (!settings.completionEnabled) return;
        const seq = ++completionSeq;
        // Cache hit: identical text already completed — render from cache with
        // no API call. Re-apply the live suppression guards (a pin/rephrase may
        // have appeared since the cache was filled).
        if (text === lastCompletionText && lastCompletionResult !== null) {
            if (detailsState.pinnedIndex() !== null || state.rephrase !== null) {
                logDebug("completion cache hit suppressed (pinned or rephrasing)", {});
                return;
            }
            logDebug("completion cache hit (no API call)", { contLen: lastCompletionResult.length });
            state.completion = { seq, continuation: lastCompletionResult, ref, atOffset };
            pushStatusLine();
            renderGhost(lastCompletionResult, atOffset);
            return;
        }
        logDebug("completion request", { textLen: text.length, atOffset, seq });
        try {
            const res = await completeFn({ text, source: SIGNAL_SOURCE });
            // Stale-seq guard.
            if (seq !== completionSeq) {
                logDebug("completion dropped (stale seq)", { seq });
                return;
            }
            // Ref-identity guard.
            const liveRef = api.prompt?.ref();
            if (liveRef !== ref) {
                logDebug("completion dropped (ref swap)", {});
                return;
            }
            // Don't show if suppressed by now (pin appeared, rephrase started).
            if (detailsState.pinnedIndex() !== null || state.rephrase !== null) {
                logDebug("completion suppressed (pinned or rephrasing)", {});
                return;
            }
            const rawContinuation = res.continuation;
            if (!rawContinuation || rawContinuation.length === 0) {
                logDebug("completion empty — no ghost", {});
                return;
            }
            // The bridge TrimSpaces the continuation, so "the" + "lazy dog."
            // would render/insert as "thelazy dog.". joinContinuation re-inserts
            // the joining space when both sides are word-ish (not for punctuation
            // continuations). atOffset is the caret (end of text), so inserting
            // the joined text there reads correctly.
            const continuation = joinContinuation(text, rawContinuation);
            // Cache the JOINED result so an identical re-request skips the API
            // and renders/accepts identically.
            lastCompletionText = text;
            lastCompletionResult = continuation;
            logDebug("completion result", { contLen: continuation.length });
            state.completion = { seq, continuation, ref, atOffset };
            // Push to status-line.
            pushStatusLine();
            // Render ghost overlay.
            renderGhost(continuation, atOffset);
        } catch (e) {
            if (seq === completionSeq) {
                logDebug("completion error", {
                    message: e instanceof Error ? e.message : String(e),
                });
            }
        }
    };

    const acceptCompletion = (): void => {
        const comp = state.completion;
        if (!comp) return;
        const liveRef = api.prompt?.ref();
        if (!liveRef || liveRef !== comp.ref) {
            state.completion = null;
            clearGhost();
            return;
        }
        // Pure insertion at the end — replaceRange with equal start/end
        // inserts the ghost text at that position.
        const continuation = comp.continuation;
        liveRef.replaceRange(comp.atOffset, comp.atOffset, continuation);
        logDebug("completion accepted", { atOffset: comp.atOffset, len: continuation.length });
        state.completion = null;
        clearGhost();
        // Trigger a grammar re-check on the now-extended text.
        onChange();
    };

    // Clear any showing/in-flight completion ghost WITHOUT touching the status
    // line (callers that already push status — e.g. the pin transition — avoid a
    // double push). Returns true if a ghost was actually cleared.
    const clearCompletionGhost = (): boolean => {
        const had = state.completion !== null || state.completionTimer !== null;
        completionSeq++; // invalidate any in-flight request
        state.completion = null;
        if (state.completionTimer !== null) {
            clearTimeout(state.completionTimer);
            state.completionTimer = null;
        }
        if (had) clearGhost();
        return had;
    };

    const dismissCompletion = (): void => {
        if (!state.completion) return;
        logDebug("completion dismissed", {});
        clearCompletionGhost();
        pushStatusLine();
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

    // Completion ghost layer — gated: active only while a ghost is visible.
    // ⇧Tab accepts, esc dismisses. When no ghost, keys pass through to host.
    const disposeCompletionLayer = api.keymap.registerLayer({
        priority: 500,
        enabled: () => state.completion !== null,
        commands: [
            {
                name: "grammarforge.completion.accept",
                title: "GrammarForge: accept completion ghost",
                run: acceptCompletion,
            },
            {
                name: "grammarforge.completion.dismiss",
                title: "GrammarForge: dismiss completion ghost",
                run: dismissCompletion,
            },
        ],
        bindings: [
            { key: "shift+tab", cmd: "grammarforge.completion.accept" },
            { key: "escape", cmd: "grammarforge.completion.dismiss" },
        ],
    });

    // Ungated review-jump layer — always active. Provides ctrl+g / ctrl+shift+g
    // to jump to the next/previous issue relative to the cursor. This layer has
    // LOWER priority than the gated details layer so that when pinned, the gated
    // bindings (return/x/ctrl+n/ctrl+p/esc) take precedence over the ungated
    // review-jump. However, ctrl+g/ctrl+shift+g are NOT in the gated layer,
    // so they never collide — review-jump AND pinned-layer commands are both
    // available while pinned.
    const reviewNext = (): void => {
        const ref = api.prompt?.ref();
        if (!ref) return;
        if (state.items.length === 0) return;
        if (ref.text !== state.checkedText) {
            // Text drifted — no safe hit-test; schedule a check and retry.
            scheduleCheck(ref);
            return;
        }
        const offset = ref.cursorOffset ?? 0;
        const result = jumpNext(offset, state.items, state.displaySpans);
        if (result === null) return;
        detailsState.pin(result.pinIndex);
        ref.setCursorOffset?.(result.cursorOffset);
    };
    const reviewPrev = (): void => {
        const ref = api.prompt?.ref();
        if (!ref) return;
        if (state.items.length === 0) return;
        if (ref.text !== state.checkedText) {
            scheduleCheck(ref);
            return;
        }
        const offset = ref.cursorOffset ?? 0;
        const result = jumpPrev(offset, state.items, state.displaySpans);
        if (result === null) return;
        detailsState.pin(result.pinIndex);
        ref.setCursorOffset?.(result.cursorOffset);
    };
    const disposeReviewLayer = api.keymap.registerLayer({
        priority: 400, // lower than the details layer (500) so gated bindings win
        commands: [
            { name: "grammarforge.review.next", title: "GrammarForge: next issue", run: reviewNext },
            { name: "grammarforge.review.prev", title: "GrammarForge: previous issue", run: reviewPrev },
        ],
        bindings: [
            { key: settings.nextIssueHotkey, cmd: "grammarforge.review.next" },
            { key: settings.prevIssueHotkey, cmd: "grammarforge.review.prev" },
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
            {
                name: "grammarforge.rephrase.regenerate",
                title: "GrammarForge: regenerate rephrase",
                run: rephrase,
            },
            {
                name: "grammarforge.rephrase.cycleAltNext",
                title: "GrammarForge: next alternative",
                run: () => {
                    if (state.rephrase?.mode !== "result") return;
                    const total = 1 + state.rephrase.alternatives.length;
                    if (total <= 1) return;
                    const nextIdx = ((state.rephrase.altIndex + 1) % total + total) % total;
                    state.rephrase.altIndex = nextIdx;
                    const ctrl = rephraseController;
                    if (!ctrl) return;
                    const currentText = nextIdx === 0
                        ? state.rephrase.rephrased!
                        : state.rephrase.alternatives[nextIdx - 1]!;
                    ctrl.setView({
                        kind: "rephrase-result",
                        original: state.rephrase.original,
                        rephrased: currentText,
                        alternatives: state.rephrase.alternatives,
                        altIndex: nextIdx,
                        altTotal: total,
                        scrollOffset: state.rephrase.scrollOffset,
                        displayStart: 0,
                    });
                },
            },
                {
                    name: "grammarforge.rephrase.cycleAltPrev",
                    title: "GrammarForge: previous alternative",
                    run: () => {
                        if (state.rephrase?.mode !== "result") return;
                        const total = 1 + state.rephrase.alternatives.length;
                        if (total <= 1) return;
                        const prevIdx = ((state.rephrase.altIndex - 1) % total + total) % total;
                        state.rephrase.altIndex = prevIdx;
                        const ctrl = rephraseController;
                        if (!ctrl) return;
                        const currentText = prevIdx === 0
                            ? state.rephrase.rephrased!
                            : state.rephrase.alternatives[prevIdx - 1]!;
                        ctrl.setView({
                            kind: "rephrase-result",
                            original: state.rephrase.original,
                            rephrased: currentText,
                            alternatives: state.rephrase.alternatives,
                            altIndex: prevIdx,
                            altTotal: total,
                            scrollOffset: state.rephrase.scrollOffset,
                            displayStart: 0,
                        });
                    },
                },
                {
                    name: "grammarforge.rephrase.scrollUp",
                    title: "GrammarForge: scroll rephrase up",
                    run: () => {
                        if (state.rephrase?.mode !== "result") return;
                        state.rephrase.scrollOffset = Math.max(0, state.rephrase.scrollOffset - 1);
                        const ctrl = rephraseController;
                        if (!ctrl) return;
                        const currentText = state.rephrase.altIndex === 0
                            ? state.rephrase.rephrased!
                            : state.rephrase.alternatives[state.rephrase.altIndex - 1]!;
                        ctrl.setView({
                            kind: "rephrase-result",
                            original: state.rephrase.original,
                            rephrased: currentText,
                            alternatives: state.rephrase.alternatives,
                            altIndex: state.rephrase.altIndex,
                            altTotal: 1 + state.rephrase.alternatives.length,
                            scrollOffset: state.rephrase.scrollOffset,
                            displayStart: 0,
                        });
                    },
                },
                {
                    name: "grammarforge.rephrase.scrollDown",
                    title: "GrammarForge: scroll rephrase down",
                    run: () => {
                        if (state.rephrase?.mode !== "result") return;
                        state.rephrase.scrollOffset = state.rephrase.scrollOffset + 1;
                        const ctrl = rephraseController;
                        if (!ctrl) return;
                        const currentText = state.rephrase.altIndex === 0
                            ? state.rephrase.rephrased!
                            : state.rephrase.alternatives[state.rephrase.altIndex - 1]!;
                        ctrl.setView({
                            kind: "rephrase-result",
                            original: state.rephrase.original,
                            rephrased: currentText,
                            alternatives: state.rephrase.alternatives,
                            altIndex: state.rephrase.altIndex,
                            altTotal: 1 + state.rephrase.alternatives.length,
                            scrollOffset: state.rephrase.scrollOffset,
                            displayStart: 0,
                        });
                    },
                },
            ],
            bindings: [
                { key: "return", cmd: "grammarforge.rephrase.accept" },
                { key: "escape", cmd: "grammarforge.rephrase.reject" },
                { key: "ctrl+/", cmd: "grammarforge.rephrase.regenerate" },
                { key: "down", cmd: "grammarforge.rephrase.cycleAltNext" },
                { key: "up", cmd: "grammarforge.rephrase.cycleAltPrev" },
                { key: "tab", cmd: "grammarforge.rephrase.cycleAltNext" },
                { key: "pageup", cmd: "grammarforge.rephrase.scrollUp" },
                { key: "pagedown", cmd: "grammarforge.rephrase.scrollDown" },
            ],
    });

    // Details layer — gated by enabled. When nothing is pinned, the
    // host keymap does not dispatch any of the layer's bindings, so
    // return/x/cycleNext/cyclePrev/escape stay free for the host's own
    // behavior. When a pin exists, the bindings become active.
    let disposeDetailsLayer: (() => void) | null = null;
    // Holder references for the detail handler functions — defined inside
    // the cursorPinSupported gate below, wired into the panel controller
    // later for A7 mouse support.
    let applyPinned: () => void = () => undefined;
    let ignorePinned: () => void = () => undefined;
    let cycleNext: () => void = () => undefined;
    let cyclePrev: () => void = () => undefined;
    let unpin: () => void = () => undefined;
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
        applyPinned = (): void => {
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
        ignorePinned = (): void => {
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
        cycleNext = (): void => {
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
        cyclePrev = (): void => {
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
        unpin = (): void => {
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
        // ── A7: Wire mouse callbacks on the panel controller ──────────
        // The handler functions (applyPinned, ignorePinned, etc.) are defined
        // inside the cursorPinSupported gate above. Wire them only when
        // cursorPinSupported is true (they're already guarded internally).
        if (cursorPinSupported) {
            controller.onApply = applyPinned;
            controller.onIgnore = ignorePinned;
            controller.onUnpin = unpin;
            controller.onCycleNext = cycleNext;
            controller.onCyclePrev = cyclePrev;
        }
        controller.onRephraseAccept = rephraseAccept;
        controller.onRephraseReject = rephraseReject;

        // ── A6: Status-line push helper ──────────────────────────────
        pushStatusLine = (): void => {
            const itemCount = state.items.length;
            const categories = [...new Set(state.items.map((it) => it.category))];
            const rephrase = state.rephrase;
            const pinnedIdx = detailsState.pinnedIndex();
            // DIAG (gated): every status push. A flood here with no user
            // input = a status/view fanout feedback loop.
            logDebug("pushStatusLine", { itemCount, pinnedIdx, hasRephrase: rephrase !== null });

            if (state.completion !== null) {
                controller.setStatusText(buildStatusLine({ state: "completion" }));
            } else if (rephrase?.mode === "loading") {
                controller.setStatusText(buildStatusLine({ state: "rephrase-loading" }));
            } else if (rephrase?.mode === "result") {
                controller.setStatusText(buildStatusLine({ state: "rephrase-result" }));
            } else if (pinnedIdx !== null && itemCount > 0) {
                controller.setStatusText(
                    buildStatusLine({
                        state: "pinned",
                        issueCount: itemCount,
                        pinnedIndex: pinnedIdx + 1,
                        cycleNextKey: settings.cycleNextHotkey,
                        cyclePrevKey: settings.cyclePrevHotkey,
                    }),
                );
            } else if (itemCount > 0) {
                controller.setStatusText(
                    buildStatusLine({
                        state: "flagged",
                        issueCount: itemCount,
                        categories,
                        nextIssueKey: settings.nextIssueHotkey,
                        applyAllKey: settings.applyAllHotkey,
                        rephraseKey: settings.rephraseHotkey,
                    }),
                );
            } else if (state.checkedText !== "") {
                // A non-empty buffer was checked and found clean → "✓ no issues".
                controller.setStatusText(buildStatusLine({ state: "clear" }));
            } else {
                // Empty buffer (or nothing checked yet) — show no status line at
                // all. "✓ no issues" on an empty prompt is misleading noise.
                controller.setStatusText("");
            }
        };

        // The transition push: build the current panel payload and
        // hand it to the controller's setter. The setter is what
        // updates the solid signal that PanelComponent reads via
        // controller.view().
        const pushFromDetailsState = (): void => {
            const index = detailsState.pinnedIndex();
            if (index === null || index >= state.items.length) {
                logDebug("unpin transition", { from: index });
                controller.setView(null);
                pushStatusLine();
                return;
            }
            const item = state.items[index]!;
            // A suggestion card and a completion ghost must never show at once
            // (both bind esc, and they'd overlap). Pinning ALWAYS wins — clear
            // any ghost here, the single chokepoint for every pin path (auto-pin
            // on cursor-rest, ctrl+g/ctrl+shift+g review-jump, ctrl+n/ctrl+p cycle).
            clearCompletionGhost();
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
            pushStatusLine();
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
        disposeCompletionLayer();
        disposeReviewLayer();
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
