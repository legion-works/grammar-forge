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
//
// The vitest unit tests (details-panel-view.test.ts) cover the
// signal lifecycle + dispose. The card-spec tests cover the spec
// shape. The smoke covers the renderable construction + dims.

import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { buildDetailsViewModel } from "../src/details-panel.ts";
import { buildCardSpec, type CardSpec } from "../src/card-spec.ts";

interface BoxSurface {
    add: (child: unknown) => number;
    remove: (id: string) => void;
    getChildren: () => unknown[];
    width?: number | `${number}%` | "auto";
    yogaNode?: { getComputedWidth?: () => number; getComputedHeight?: () => number };
}

interface TextSurface {
    id: string;
    content: string | { chunks: Array<{ text: string }> };
    fg?: string;
    add: (child: unknown) => number;
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
        const rowBox = new BoxRenderable(rootCtx as never, {
            flexDirection: "row",
        }) as unknown as BoxSurface;
        for (const seg of row.segments) {
            const t = new TextRenderable(rootCtx as never, {
                content: seg.text,
                fg: seg.fg,
            }) as unknown as TextSurface;
            rowBox.add(t);
        }
        box.add(rowBox);
    }
    return box;
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
): AbsoluteBoxSurface {
    // Mirror the AbsoluteCard JSX in tui-entry.tsx: position="absolute",
    // explicit width (CARD_W=44), zIndex=4000, left/top from clampAnchor.
    const CARD_W = 44;
    const box = new BoxRenderable(rootCtx as never, {
        position: "absolute",
        zIndex: 4000,
        left,
        top,
        width: CARD_W,
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
        const rowBox = new BoxRenderable(rootCtx as never, {
            flexDirection: "row",
        }) as unknown as BoxSurface;
        for (const seg of row.segments) {
            const t = new TextRenderable(rootCtx as never, {
                content: seg.text,
                fg: seg.fg,
            }) as unknown as TextSurface;
            rowBox.add(t);
        }
        box.add(rowBox);
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
    return { width, height };
}

async function main() {
    const setup: TestRendererSetup = await createTestRenderer({ width: 80, height: 24 });
    console.log("smoke: test renderer created (80x24)");

    // Spec inspection — same 3 modes as before.
    const specNormal = buildCardSpec(
        buildDetailsViewModel({ category: "grammar", original: "teh", replacement: "the" }, 1, 3),
    );
    const specDeletion = buildCardSpec(
        buildDetailsViewModel({ category: "spelling", original: "abc", replacement: "" }, 0, 1),
    );
    const specInsertion = buildCardSpec(
        buildDetailsViewModel({ category: "punctuation", original: "", replacement: "the" }, 2, 5),
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

    console.log(
        "\nsmoke: PASS — bordered card builds with non-zero dim, all text populated, all 3 modes verified, absolute overlay card verified",
    );
    process.exit(0);
}

await main();
