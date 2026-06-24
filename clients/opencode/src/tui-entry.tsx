/** @jsxImportSource @opentui/solid */
// GrammarForge TUI plugin — bun-loaded source entry. The host's
// bun runtime transpiles this file via the package's tsconfig
// (jsx: "react-jsx", jsxImportSource: "@opentui/solid"). solid-js /
// @opentui/solid / @opentui/core resolve from the package's own
// node_modules. Foreign-instance solid provably works this way
// live (see anthropic-auth's quota sidebar).
//
// WHY IN-COMPONENT SIGNAL: our BUNDLED solid instance has its own
// scheduler the host never pumps. Signals/effects created at
// tui()-time or in a detached createRoot queue updates that never
// flush. ONLY a signal created inside the component the HOST
// MOUNTS rides the host's scheduler and reacts. The orchestrator
// owns the controller (a pure setView+subscribe holder); the
// PanelComponent creates its OWN createSignal at mount and
// subscribes the local setter to the controller's setView
// fanout. No monkeypatching; clean fanout.
//
// SINGLE REGISTRATION. The orchestrator does NOT register slots;
// it only does the setView bridge. The slot registration and
// JSX render live entirely here.
//
// FLOATING OVERLAY ARCHITECTURE:
//   - Slot fn returns PanelComponent which renders a FRAGMENT:
//     (a) an ALWAYS-PRESENT in-flow <box width={0} height={0}/> so
//         the slot registry's hasInitialOutput check passes and the
//         entry is never pruned (gotcha 3).
//     (b) <Portal> rendering an AbsoluteCard at the render root,
//         escaping the slot's cropping layout (gotcha 3 + Portal
//         precedent from permission.tsx).
//   - AbsoluteCard is positioned ABOVE the pinned word via
//     api.prompt.ref()?.offsetToScreen(displayStart) (lazy read at
//     render time — ref is null at tui()-time, gotcha 4).
//   - clampAnchor() handles edge clamping (word near right/top edge).
//   - GF_TUI_DEBUG=1 logs an "overlay anchor" line with all coords.

import { createSignal, Show, onCleanup } from "solid-js";
import { Portal, useTerminalDimensions } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import type { TuiApi, TuiPlugin, TuiPluginModule } from "./opencode-types";
import { startOrchestrator, type PanelController } from "./orchestrator";
import { createDetailsPanelController } from "./details-panel-view";
import type { PanelView } from "./details-panel-view";
import { buildDetailsViewModel } from "./details-panel";
import {
    buildCardSpec,
    buildRephraseLoadingCardSpec,
    buildRephraseResultCardSpec,
} from "./card-spec";
import { clampAnchor, ghostAnchor } from "./overlay-anchor";
import {
    currentGhostPayload,
    pushGhostPayload,
    subscribeGhost,
    type GhostPayload,
} from "./ghost-overlay";
import { logDebug } from "./debug";
import { makeDisplayWidth, bunSegmentWidth } from "./display-width";

const ID = "grammarforge";

// Card dimensions (columns × rows, including border).
// Width: 44 cols is wide enough for most suggestions without
// dominating the terminal. Height: 3 content rows + 2 border = 5.
const CARD_W = 44;
const CARD_H = 5; // 3 content rows + top/bottom border

const tui: TuiPlugin = async (api: TuiApi, options) => {
    logDebug("tui() entered", { id: ID, hasOptions: options !== undefined });
    const controller: PanelController = createDetailsPanelController();
    const panelRenderer = (): PanelController => controller;
    const ghostRenderer = {
        renderGhost: (text: string, atOffset: number) => {
            pushGhostPayload({ text, atOffset });
        },
        clearGhost: () => {
            pushGhostPayload(null);
        },
    };
    // Pass the host-supplied plugin options through to the orchestrator —
    // these carry the tui.json settings (completionEnabled, bridgeUrl,
    // hotkeys, …). The host invokes the plugin as tui(api, options, meta);
    // dropping `options` here (the prior `startOrchestrator(api, undefined, …)`)
    // silently forced resolveSettings() to ALL defaults, so no tui.json
    // setting ever reached the plugin. Tuple form in tui.json — e.g.
    // ["file://…/clients/opencode", { "completionEnabled": true }] — is the
    // supported mechanism (host config/plugin.ts passes plugin[1] as options).
    const stop = startOrchestrator(api, options, { panelRenderer, ghostRenderer });
    api.lifecycle.onDispose(() => {
        logDebug("plugin teardown: orchestrator stop + controller dispose");
        stop();
        controller.dispose();
    });
    if (api.slots) {
        api.slots.register({
            slots: {
                home_prompt_right: () => {
                    logDebug("slot fn home_prompt_right invoked");
                    return (
                        <>
                            <PanelComponent controller={controller} api={api} />
                            <GhostComponent api={api} />
                        </>
                    );
                },
                session_prompt_right: () => {
                    logDebug("slot fn session_prompt_right invoked");
                    return (
                        <>
                            <PanelComponent controller={controller} api={api} />
                            <GhostComponent api={api} />
                        </>
                    );
                },
            },
        });
        logDebug("slots registered", { names: ["home_prompt_right", "session_prompt_right"] });
    }
};

const plugin: TuiPluginModule & { id: string } = {
    id: ID,
    tui,
};

export default plugin;

// Panel component: renders a FRAGMENT with:
//   (a) an ALWAYS-PRESENT zero-size in-flow box (slot pruning guard)
//   (b) a Portal containing the AbsoluteCard (floating overlay)
//
// The load-bearing piece: localView is a createSignal CREATED INSIDE
// this function — it rides the host's scheduler. The controller's
// setView fanout pushes the payload into localView via subscribe.
function PanelComponent(props: { controller: PanelController; api: TuiApi }) {
    // Initialize from the controller's CURRENT values, not null/"". The host
    // re-invokes the slot fn on prompt re-renders, re-mounting PanelComponent;
    // a null default would blank the live card/status on the next keystroke.
    // Reading currentView/currentStatus at mount restores the live state.
    const [localView, setLocalView] = createSignal<PanelView | null>(
        props.controller.currentView(),
    );
    const [statusText, setStatusText] = createSignal(props.controller.currentStatus());
    const unsubscribe = props.controller.subscribe((next) => {
        setLocalView(next);
    });
    const unsubscribeStatus = props.controller.subscribeStatus(setStatusText);
    onCleanup(() => {
        unsubscribe();
        unsubscribeStatus();
    });
    // useTerminalDimensions() is a reactive accessor from @opentui/solid.
    // It returns { width, height } in terminal cells. Used for edge clamping.
    const dimensions = useTerminalDimensions();
    logDebug("panel component mounted (initial render)");
    return (
        <>
            {/* ALWAYS-PRESENT in-flow anchor: zero size, invisible.
                The slot registry's hasInitialOutput check requires
                non-null initial output or it prunes the entry and
                the component is never mounted (gotcha 3). */}
            <box width={0} height={0} />
            {/* Status-line (A6) — always-on dim row under the prompt. */}
            <Show when={statusText()} keyed>
                {(t) => (
                    <box flexDirection="row">
                        <text fg="#6b7280">{t}</text>
                    </box>
                )}
            </Show>
            {/* Floating overlay: Portal renders at the render root,
                escaping the slot's cropping layout. AbsoluteCard
                uses position="absolute" + zIndex to float above
                all other content. */}
            <Portal
                ref={(container: {}) => {
                    const c = container as {
                        position: string;
                        left: number;
                        top: number;
                        zIndex: number;
                    };
                    c.position = "absolute";
                    c.left = 0;
                    c.top = 0;
                    c.zIndex = 4000;
                }}
            >
                <Show when={localView()} keyed>
                    {(current) => {
                        // Build the card spec by discriminating on kind.
                        let spec;
                        if (current.kind === "rephrase-loading") {
                            spec = buildRephraseLoadingCardSpec(current.frame);
                        } else if (current.kind === "rephrase-result") {
                            spec = buildRephraseResultCardSpec(current, makeDisplayWidth(bunSegmentWidth));
                        } else {
                            // kind === "suggestion"
                            const vm = buildDetailsViewModel(
                                current.item,
                                current.index,
                                current.total,
                                current.cycleNextKey,
                                current.cyclePrevKey,
                            );
                            spec = buildCardSpec(vm);
                        }
                        // Lazily read the prompt ref at render time (gotcha 4:
                        // ref is null at tui()-time; it's mounted by now because
                        // something is pinned — the orchestrator only calls
                        // setView when a cursor hit-test succeeds, which requires
                        // a live ref).
                        const anchor =
                            props.api.prompt?.ref()?.offsetToScreen?.(current.displayStart) ?? null;
                        const dims = dimensions();
                        const screenW = dims.width;
                        const screenH = dims.height;
                        // Card height varies by kind.
                        const cardH = current.kind === "rephrase-result"
                            ? (spec as unknown as { contentRows: number }).contentRows + 4
                            : CARD_H;
                        const clamped = anchor
                            ? clampAnchor(anchor, CARD_W, cardH, screenW, screenH)
                            : null;
                        if (current.kind === "suggestion") {
                            logDebug("panel content visible", {
                                index: current.index,
                                total: current.total,
                                category: current.item.category,
                            });
                        } else {
                            logDebug("panel content visible", { kind: current.kind });
                        }
                        logDebug("overlay anchor", {
                            offset: current.displayStart,
                            anchorX: anchor?.x ?? null,
                            anchorY: anchor?.y ?? null,
                            clampedLeft: clamped?.left ?? null,
                            clampedTop: clamped?.top ?? null,
                            screenW,
                            screenH,
                            cardW: CARD_W,
                            cardH,
                        });
                        // If offsetToScreen returned null (prompt unmounted,
                        // offset out of range, or no offsetToScreen support),
                        // don't render the card — never crash.
                        if (!clamped) return null;
                        return (
                            <box
                                position="absolute"
                                zIndex={4000}
                                left={clamped.left}
                                top={clamped.top}
                                width={CARD_W}
                                border
                                borderStyle="single"
                                borderColor={spec.borderColor}
                                backgroundColor={RGBA.fromInts(28, 28, 30, 210)}
                                paddingLeft={1}
                                paddingRight={1}
                                paddingTop={0}
                                paddingBottom={0}
                                flexDirection="column"
                                onMouseDown={() => {
                                    // A7: Click on the card → apply the pinned suggestion.
                                    // Degrades gracefully when terminal doesn't report mouse.
                                    if (current.kind === "suggestion") {
                                        props.controller.onApply?.();
                                    } else if (current.kind === "rephrase-result") {
                                        props.controller.onRephraseAccept?.();
                                    }
                                }}
                            >
                                {spec.rows.map((row) => (
                                    <box flexDirection="row">
                                        {row.segments.map((seg) => (
                                            <text fg={seg.fg}>
                                                {seg.bold ? <b>{seg.text}</b> : seg.text}
                                            </text>
                                        ))}
                                    </box>
                                ))}
                            </box>
                        );
                    }}
                </Show>
            </Portal>
        </>
    );
}

// ── Ghost completion overlay (Path A self-render) ──────────────────────
// TODO(Path B): swap this entire component for promptRef.ghostText.
//   When the native @opentui/core primitive is available, replace the
//   <Portal> + <box> below with a one-liner:
//     api.prompt?.ref()?.ghostText?.set(text, { atOffset })
//   The orchestrator's trigger/accept/cancel logic stays unchanged.

const GHOST_Z_INDEX = 3500; // below the suggestion card (4000)

function GhostComponent(props: { api: TuiApi }) {
    // Initialize from the current ghost payload, not null — the host re-invokes
    // the slot fn on prompt re-renders, re-mounting this component; a null
    // default would blank a live ghost. Same fix as PanelComponent.
    const [ghost, setGhost] = createSignal<GhostPayload | null>(currentGhostPayload());
    const dimensions = useTerminalDimensions();

    // Subscribe this instance's setter so the orchestrator's imperative
    // renderGhost/clearGhost calls reach it. Unlike the old single-setter
    // design, EVERY live GhostComponent is updated — a remount can't strand
    // the orchestrator's push at a disposed signal. Cleaned up on unmount.
    const unsubscribeGhost = subscribeGhost((v) => setGhost(() => v));
    onCleanup(unsubscribeGhost);

    // SolidJS: the component body runs ONCE. A signal read here (ghost())
    // is NOT reactive — it would return null at mount and never re-render.
    // Use <Show when={ghost()} keyed> to create a reactive scope that
    // re-executes when the signal changes. Same pattern as PanelComponent's
    // <Show when={localView()} keyed> at L170.
    return (
        <Show when={ghost()} keyed>
            {(current) => {
                const anchor = props.api.prompt?.ref()?.offsetToScreen?.(current.atOffset) ?? null;
                const dims = dimensions();
                const screenW = dims.width;
                const screenH = dims.height;
                const ghostW = Math.min(80, Math.max(10, screenW - (anchor?.x ?? 0) - 1));
                // Inline ghost text uses ghostAnchor (NOT clampAnchor): it sits
                // on the caret's EXACT row. clampAnchor is for the floating card
                // and renders one row ABOVE the anchor (top = y - cardH), which
                // put the ghost on the blank line above the prompt in session
                // view (prompt pinned to the terminal bottom).
                const clamped = anchor ? ghostAnchor(anchor, screenW, screenH) : null;
                if (!clamped) return null;

                logDebug("ghost overlay rendered", {
                    text: current.text.substring(0, 30),
                    atOffset: current.atOffset,
                    anchorX: anchor?.x ?? null,
                    anchorY: anchor?.y ?? null,
                    clampedLeft: clamped.left,
                    clampedTop: clamped.top,
                });

                return (
                    <Portal
                        ref={(container: {}) => {
                            const c = container as {
                                position: string;
                                left: number;
                                top: number;
                                zIndex: number;
                            };
                            c.position = "absolute";
                            c.left = 0;
                            c.top = 0;
                            c.zIndex = GHOST_Z_INDEX;
                        }}
                    >
                        <box
                            position="absolute"
                            zIndex={GHOST_Z_INDEX}
                            left={clamped.left}
                            top={clamped.top}
                            width={ghostW}
                            height={1}
                        >
                            <text fg="#6b7280">{current.text}</text>
                        </box>
                    </Portal>
                );
            }}
        </Show>
    );
}
