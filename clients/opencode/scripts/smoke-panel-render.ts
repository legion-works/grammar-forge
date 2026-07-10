// Headless render smoke for the LIVE render path. The controller's
// render() uses opentui's createElement which needs a live
// RendererContext (provided by the host's bundled solid runtime in
// production). In this headless smoke we don't have a RendererContext,
// so we exercise the SAME imperative path the controller uses
// (new BoxRenderable + new TextRenderable against the test renderer's
// root._ctx) — verified to be the same path opencode uses
// (scrollback.surface.ts:159, splash.ts:119,248).
//
// This smoke proves:
//   1. The bordered card with width="100%" produces a non-zero
//      post-layout width AND height (the dim assertion that catches
//      the width-collapse bug headlessly).
//   2. The card has 3 row children with REAL text content
//      (NOT undefined — the dead-field class regression guard).
//   3. After clearing all children, a re-add (simulating setView
//      transitioning to a new payload) re-populates them with NEW
//      content. This is the orphaned-reactivity bug class guard:
//      the imperative owner-effect rebuilds on every transition;
//      a foreign-scope <Show> would not re-fire.
//   4. REGRESSION GUARD (URGENT fix, see HARNESS.md): every row that
//      carries MULTIPLE <text> segments (card-spec.ts's discrete
//      apply/ignore/cycle hint segments; a wrapped diff row's
//      arrow+first-line pair) renders as a SINGLE line — it never
//      internally re-wraps and jams adjacent segments into each other
//      (the "hints overlapping" / "pinned word vanishes" bugs). This
//      mirrors tui-entry.tsx's actual row/text props exactly
//      (`overflow="hidden"` on the row, `wrapMode="none"` +
//      `flexShrink={0}` on each segment) so a future regression here
//      is caught the same way it slipped through before: this smoke
//      renders through the REAL renderer/yoga layout, which the
//      jsdom-free vitest suite (card-spec.test.ts) never does — that
//      suite only inspects the CardSpec data, never how opentui lays
//      multiple <text> children out in a row.
//
// The vitest unit tests (details-panel-view.test.ts) cover the
// signal lifecycle + dispose. The card-spec tests cover the spec
// shape. The smoke covers the renderable construction + dims.

import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { buildDetailsViewModel } from "../src/details-panel.ts";
import {
    buildCardSpec,
    buildRephraseLoadingCardSpec,
    buildRephraseResultCardSpec,
    type CardSpec,
} from "../src/card-spec.ts";
import { makeDisplayWidth, bunSegmentWidth } from "../src/display-width.ts";

const displayWidthOf = makeDisplayWidth(bunSegmentWidth);

interface BoxSurface {
    add: (child: unknown) => number;
    remove: (id: string) => void;
    getChildren: () => unknown[];
    width?: number | `${number}%` | "auto";
    yogaNode?: {
        getComputedWidth?: () => number;
        getComputedHeight?: () => number;
    };
}

interface TextSurface {
    id: string;
    content: string | { chunks: Array<{ text: string }> };
    fg?: string;
    add: (child: unknown) => number;
    yogaNode?: { getComputedHeight?: () => number };
}

/** Build a row <box> + <text> children EXACTLY mirroring tui-entry.tsx's
 *  props for the fix under test (overflow="hidden" on the row,
 *  wrapMode="none" + flexShrink=0 on each segment) — see that file's
 *  matching comment. Any divergence here should be treated as a bug in
 *  the smoke, not a license to skip the real props. */
function buildRow(rootCtx: unknown, segments: CardSpec["rows"][number]["segments"]): BoxSurface {
    const rowBox = new BoxRenderable(rootCtx as never, {
        flexDirection: "row",
        overflow: "hidden",
    }) as unknown as BoxSurface;
    for (const seg of segments) {
        const t = new TextRenderable(rootCtx as never, {
            content: seg.text,
            fg: seg.fg,
            wrapMode: "none",
            flexShrink: 0,
        }) as unknown as TextSurface;
        rowBox.add(t);
    }
    return rowBox;
}

function buildCard(rootCtx: unknown, spec: CardSpec): BoxSurface {
    // Same imperative API the controller's createRoot + createEffect
    // uses (details-panel-view.ts:128-179). width="100%" is the
    // fix from baf90e9's regression — without it, the box
    // collapses to zero width in the slot's flex column.
    const box = new BoxRenderable(rootCtx as never, {
        width: "100%",
        border: true,
        borderStyle: "single",
        borderColor: spec.borderColor,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        flexDirection: "column",
    }) as unknown as BoxSurface;
    for (const row of spec.rows) {
        box.add(buildRow(rootCtx, row.segments));
    }
    return box;
}

/** Assert every ROW box in `box` stayed exactly 1 line tall post-layout —
 *  the regression guard described in the file header. A row with multiple
 *  segments that internally re-wraps/jams grows to height >= 2. */
function assertRowsSingleLine(label: string, box: BoxSurface): void {
    const rows = box.getChildren() as Array<{
        getChildren: () => unknown[];
        yogaNode?: { getComputedHeight?: () => number };
    }>;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const h = row.yogaNode?.getComputedHeight?.() ?? 1;
        const segCount = row.getChildren().length;
        if (h > 1) {
            console.error(
                `FAIL[${label}]: row ${i} (${segCount} segments) rendered at height=${h} ` +
                    `(expected 1) — segments are jamming/overlapping instead of clipping. ` +
                    `This is the "hints overlapping" / "pinned word vanishes" regression class.`,
            );
            process.exit(1);
        }
    }
    console.log(`smoke[${label}]: all ${rows.length} rows stayed single-line ✓`);
}

async function verify(
    label: string,
    spec: CardSpec,
    setup: TestRendererSetup,
): Promise<{ width: number; height: number }> {
    const root = (
        setup.renderer as unknown as {
            root?: { add: (x: unknown) => number; getChildren: () => unknown[]; _ctx?: unknown };
        }
    ).root;
    if (!root || !root._ctx) {
        console.error("FAIL: no root._ctx on test renderer");
        process.exit(1);
    }
    const box = buildCard(root._ctx, spec);
    root.add(box);
    if (typeof setup.flush === "function") await setup.flush();
    if (typeof setup.renderOnce === "function") await setup.renderOnce();
    await new Promise((r) => setTimeout(r, 30));
    const yogaNode = box.yogaNode;
    const width =
        yogaNode && typeof yogaNode.getComputedWidth === "function"
            ? yogaNode.getComputedWidth()
            : 0;
    const height =
        yogaNode && typeof yogaNode.getComputedHeight === "function"
            ? yogaNode.getComputedHeight()
            : 0;
    console.log(`smoke[${label}]: post-layout width=${width} height=${height}`);
    if (width <= 0) {
        console.error(`FAIL[${label}]: width=${width} (expected > 0)`);
        process.exit(1);
    }
    if (height <= 0) {
        console.error(`FAIL[${label}]: height=${height} (expected > 0)`);
        process.exit(1);
    }
    const children = box.getChildren();
    if (children.length !== 3) {
        console.error(`FAIL[${label}]: expected 3 row children, got ${children.length}`);
        process.exit(1);
    }
    let textCount = 0;
    for (let r = 0; r < children.length; r++) {
        const row = children[r] as { getChildren: () => unknown[] };
        const rowKids = row.getChildren();
        for (let s = 0; s < rowKids.length; s++) {
            const t = rowKids[s] as { content: string | { chunks: Array<{ text: string }> } };
            // TextRenderable's `content` is a StyledText object
            // { chunks: [{ text }] } in opentui 0.4.x. Accept
            // both the string form and the StyledText form.
            let text = "";
            if (typeof t.content === "string") {
                text = t.content;
            } else if (t.content && Array.isArray(t.content.chunks)) {
                text = t.content.chunks.map((c) => c.text).join("");
            }
            if (text.length === 0) {
                console.error(
                    `FAIL[${label}]: row ${r} seg ${s} empty content: ${JSON.stringify(t.content)}`,
                );
                process.exit(1);
            }
            textCount++;
        }
    }
    console.log(`smoke[${label}]: ${textCount} text children populated ✓`);
    assertRowsSingleLine(label, box);
    return { width, height };
}

interface AbsoluteBoxSurface {
    add: (child: unknown) => number;
    remove: (id: string) => void;
    getChildren: () => unknown[];
    width?: number | `${number}%` | "auto";
    yogaNode?: { getComputedWidth?: () => number; getComputedHeight?: () => number };
    position?: string;
    left?: number;
    top?: number;
    zIndex?: number;
}

function buildAbsoluteCard(
    rootCtx: unknown,
    spec: CardSpec,
    left: number,
    top: number,
    width: number = 44,
): AbsoluteBoxSurface {
    // Mirror the AbsoluteCard JSX in tui-entry.tsx: position="absolute",
    // explicit width (CARD_W=44 by default, or the caller's responsive
    // computeCardWidth() result), zIndex=4000, left/top from clampAnchor.
    const box = new BoxRenderable(rootCtx as never, {
        position: "absolute",
        zIndex: 4000,
        left,
        top,
        width,
        border: true,
        borderStyle: "single",
        borderColor: spec.borderColor,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        flexDirection: "column",
    }) as unknown as AbsoluteBoxSurface;
    for (const row of spec.rows) {
        box.add(buildRow(rootCtx, row.segments) as unknown as BoxSurface as never);
    }
    return box;
}

async function verifyAbsolute(
    label: string,
    spec: CardSpec,
    left: number,
    top: number,
    setup: TestRendererSetup,
): Promise<{ width: number; height: number }> {
    const root = (
        setup.renderer as unknown as {
            root?: { add: (x: unknown) => number; getChildren: () => unknown[]; _ctx?: unknown };
        }
    ).root;
    if (!root || !root._ctx) {
        console.error("FAIL: no root._ctx on test renderer");
        process.exit(1);
    }
    const box = buildAbsoluteCard(root._ctx, spec, left, top);
    root.add(box);
    if (typeof setup.flush === "function") await setup.flush();
    if (typeof setup.renderOnce === "function") await setup.renderOnce();
    await new Promise((r) => setTimeout(r, 30));
    const yogaNode = box.yogaNode;
    const width =
        yogaNode && typeof yogaNode.getComputedWidth === "function"
            ? yogaNode.getComputedWidth()
            : 0;
    const height =
        yogaNode && typeof yogaNode.getComputedHeight === "function"
            ? yogaNode.getComputedHeight()
            : 0;
    console.log(
        `smoke[${label}]: absolute card post-layout width=${width} height=${height} left=${box.left} top=${box.top} zIndex=${box.zIndex}`,
    );
    if (width <= 0) {
        console.error(`FAIL[${label}]: absolute card width=${width} (expected > 0)`);
        process.exit(1);
    }
    if (height <= 0) {
        console.error(`FAIL[${label}]: absolute card height=${height} (expected > 0)`);
        process.exit(1);
    }
    // Verify position props are set on the renderable.
    if (box.left !== left) {
        console.error(`FAIL[${label}]: expected left=${left}, got ${box.left}`);
        process.exit(1);
    }
    if (box.top !== top) {
        console.error(`FAIL[${label}]: expected top=${top}, got ${box.top}`);
        process.exit(1);
    }
    if (box.zIndex !== 4000) {
        console.error(`FAIL[${label}]: expected zIndex=4000, got ${box.zIndex}`);
        process.exit(1);
    }
    const children = box.getChildren();
    if (children.length !== 3) {
        console.error(`FAIL[${label}]: expected 3 row children, got ${children.length}`);
        process.exit(1);
    }
    console.log(`smoke[${label}]: absolute card position props OK, ${children.length} rows ✓`);
    assertRowsSingleLine(label, box as unknown as BoxSurface);
    return { width, height };
}

async function main() {
    const setup: TestRendererSetup = await createTestRenderer({ width: 80, height: 24 });
    console.log("smoke: test renderer created (80x24)");

    // Spec inspection — same 3 modes as before. cycleNextKey/cyclePrevKey
    // use the real default hotkeys (ctrl+n/ctrl+p) so the hints row is the
    // REAL length production renders, not an artificially short stub.
    const specNormal = buildCardSpec(
        buildDetailsViewModel(
            { category: "grammar", original: "teh", replacement: "the" },
            1,
            3,
            "ctrl+n",
            "ctrl+p",
        ),
        displayWidthOf,
    );
    const specDeletion = buildCardSpec(
        buildDetailsViewModel(
            { category: "spelling", original: "abc", replacement: "" },
            0,
            1,
            "ctrl+n",
            "ctrl+p",
        ),
        displayWidthOf,
    );
    const specInsertion = buildCardSpec(
        buildDetailsViewModel(
            { category: "punctuation", original: "", replacement: "the" },
            2,
            5,
            "ctrl+n",
            "ctrl+p",
        ),
        displayWidthOf,
    );
    let total = 0;
    for (const spec of [specNormal, specDeletion, specInsertion]) {
        for (const row of spec.rows) {
            for (const seg of row.segments) {
                if (typeof seg.text !== "string" || seg.text.length === 0) {
                    console.error(`FAIL: spec has empty segment: ${JSON.stringify(seg)}`);
                    process.exit(1);
                }
                total += seg.text.length;
            }
        }
    }
    console.log(`smoke: 3 specs (normal/deletion/insertion) verified — total ${total} chars ✓`);

    // Build + verify the normal card.
    const normalDims = await verify("normal", specNormal, setup);
    if (normalDims.width !== 80) {
        console.error(`FAIL: expected width=80, got ${normalDims.width}`);
        process.exit(1);
    }
    if (normalDims.height < 3) {
        console.error(`FAIL: expected height >= 3, got ${normalDims.height}`);
        process.exit(1);
    }
    console.log(
        `smoke: normal card dims width=80 height=${normalDims.height} (border 2 + 3 text rows) ✓`,
    );

    // Build + verify the deletion card (verifies the right color
    // resolution for the deletion diff mode).
    const deletionDims = await verify("deletion", specDeletion, setup);
    console.log(
        `smoke: deletion card dims width=${deletionDims.width} height=${deletionDims.height} ✓`,
    );

    // AbsoluteCard smoke: verify position="absolute" + explicit width
    // produces non-zero dims and position props are set correctly.
    // This is the overlay card path (tui-entry.tsx AbsoluteCard).
    // left=10, top=10 simulates a word at col 10, row 15 with card
    // positioned above (15 - 5 = 10).
    const absoluteDims = await verifyAbsolute("absolute", specNormal, 10, 10, setup);
    console.log(
        `smoke: absolute card dims width=${absoluteDims.width} height=${absoluteDims.height} ✓`,
    );

    // ─── Real-width hints-row smoke (the "B: hints overlapping" repro) ───
    // At the CARD_W=44 default, the DEFAULT hints text ("⏎ apply · x ignore
    // · ctrl+n ctrl+p cycle · esc close", 52 display columns) is WIDER than
    // the card's innerWidth (40) — this is the exact case the user hit, not
    // an edge case. Render it standalone and print the frame so a human
    // can eyeball it; assertRowsSingleLine is the automated guard.
    {
        const setupNarrowHints: TestRendererSetup = await createTestRenderer({
            width: 80,
            height: 24,
        });
        const root = (
            setupNarrowHints.renderer as unknown as {
                root?: { add: (x: unknown) => number; _ctx?: unknown };
            }
        ).root!;
        const box = buildAbsoluteCard(root._ctx, specNormal, 2, 2, 44);
        root.add(box as never);
        await setupNarrowHints.renderOnce();
        await new Promise((r) => setTimeout(r, 30));
        console.log("\nsmoke[hints-row @ default CARD_W=44]: rendered frame —");
        console.log(setupNarrowHints.captureCharFrame());
        assertRowsSingleLine("hints-row-default-width", box as unknown as BoxSurface);
    }

    // ─── Rephrase card smokes ─────────────────────────────────────────────────
    // Verify rephrase-loading and rephrase-result cards build with non-zero dims
    // and all text segments populated. These are live-only (spinner animation +
    // result layout), so this is the only render coverage for them.

    const verifyRephrase = async (
        label: string,
        spec: CardSpec,
        setup: TestRendererSetup,
    ): Promise<{ width: number; height: number }> => {
        const root = (
            setup.renderer as unknown as {
                root?: {
                    add: (x: unknown) => number;
                    getChildren: () => unknown[];
                    _ctx?: unknown;
                };
            }
        ).root;
        if (!root || !root._ctx) {
            console.error("FAIL: no root._ctx on test renderer");
            process.exit(1);
        }
        const box = buildAbsoluteCard(root._ctx, spec, 5, 5);
        root.add(box);
        if (typeof setup.flush === "function") await setup.flush();
        if (typeof setup.renderOnce === "function") await setup.renderOnce();
        await new Promise((r) => setTimeout(r, 30));
        const yogaNode = box.yogaNode;
        const width =
            yogaNode && typeof yogaNode.getComputedWidth === "function"
                ? yogaNode.getComputedWidth()
                : 0;
        const height =
            yogaNode && typeof yogaNode.getComputedHeight === "function"
                ? yogaNode.getComputedHeight()
                : 0;
        console.log(`smoke[${label}]: post-layout width=${width} height=${height}`);
        if (width <= 0) {
            console.error(`FAIL[${label}]: width=${width} (expected > 0)`);
            process.exit(1);
        }
        if (height <= 0) {
            console.error(`FAIL[${label}]: height=${height} (expected > 0)`);
            process.exit(1);
        }
        // Row count is DERIVED from the spec, not hardcoded — a hardcoded
        // expectation here is exactly what let this smoke silently break
        // (and stop running at all) the last time card-spec's row shape
        // changed (missing displayWidthOf arg after P1-5). Trust the spec;
        // just verify the renderable tree has the SAME row count as the
        // spec that built it.
        const children = box.getChildren();
        if (children.length !== spec.rows.length) {
            console.error(
                `FAIL[${label}]: expected ${spec.rows.length} row children (from spec), got ${children.length}`,
            );
            process.exit(1);
        }
        let textCount = 0;
        for (let r = 0; r < children.length; r++) {
            const row = children[r] as { getChildren: () => unknown[] };
            const rowKids = row.getChildren();
            for (let s = 0; s < rowKids.length; s++) {
                const t = rowKids[s] as {
                    content: string | { chunks: Array<{ text: string }> };
                };
                let text = "";
                if (typeof t.content === "string") {
                    text = t.content;
                } else if (t.content && Array.isArray(t.content.chunks)) {
                    text = t.content.chunks.map((c) => c.text).join("");
                }
                if (text.length === 0) {
                    console.error(
                        `FAIL[${label}]: row ${r} seg ${s} empty content: ${JSON.stringify(t.content)}`,
                    );
                    process.exit(1);
                }
                textCount++;
            }
        }
        console.log(`smoke[${label}]: ${textCount} text children populated ✓`);
        assertRowsSingleLine(label, box as unknown as BoxSurface);
        return { width, height };
    };

    // Rephrase loading card (frame 0 and frame 5 to test spinner cycling).
    const loadingSpec0 = buildRephraseLoadingCardSpec(0);
    const loadingSpec5 = buildRephraseLoadingCardSpec(5);
    for (const [label, spec] of [
        ["rephrase-loading-frame0", loadingSpec0],
        ["rephrase-loading-frame5", loadingSpec5],
    ] as const) {
        const dims = await verifyRephrase(label, spec, setup);
        console.log(`smoke[${label}]: dims width=${dims.width} height=${dims.height} ✓`);
    }

    // Rephrase result card. buildRephraseResultCardSpec's REQUIRED params
    // are (view, displayWidthOf, theme?, innerWidth?) — displayWidthOf has
    // NO default (unlike buildCardSpec's optional theme/innerWidth), and
    // RephraseResultView requires alternatives/altIndex/altTotal/
    // scrollOffset. Omitting any of these throws at call time (exactly what
    // happened here before this fix — this smoke crashed on the very next
    // line and every assertion below it silently never ran).
    const makeRephraseView = (original: string, rephrased: string) => ({
        kind: "rephrase-result" as const,
        original,
        rephrased,
        alternatives: [] as string[],
        altIndex: 0,
        altTotal: 1,
        scrollOffset: 0,
        displayStart: 0,
    });
    const resultSpec = buildRephraseResultCardSpec(
        makeRephraseView("Hello world", "Hi there world"),
        displayWidthOf,
    );
    const resultDims = await verifyRephrase("rephrase-result", resultSpec, setup);
    console.log(
        `smoke[rephrase-result]: dims width=${resultDims.width} height=${resultDims.height} ✓`,
    );

    // Rephrase result card with long text (wrap path) — this is also the
    // "A: pinned word vanishes" repro: a long replacement wraps the
    // arrow+first-line row, and without the innerWidth-minus-arrow-width
    // fix in card-spec.ts, that row overflowed and jammed (e.g. the arrow
    // gluing onto the first word, eating its separating space).
    const resultSpecLong = buildRephraseResultCardSpec(
        makeRephraseView(
            "a".repeat(60),
            "the extraordinarily lengthy and verbose replacement phrase",
        ),
        displayWidthOf,
    );
    const resultLongDims = await verifyRephrase("rephrase-result-long", resultSpecLong, setup);
    console.log(
        `smoke[rephrase-result-long]: dims width=${resultLongDims.width} height=${resultLongDims.height} ✓`,
    );

    console.log(
        "\nsmoke: PASS — bordered card builds with non-zero dim, all text populated, all 3 modes verified, absolute overlay card verified, rephrase-loading + rephrase-result cards verified, no row overlap/jamming",
    );
    process.exit(0);
}

await main();
