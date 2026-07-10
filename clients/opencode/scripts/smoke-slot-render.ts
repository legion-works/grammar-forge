// Headless smoke harness — exercise the tui entry the way the opencode
// host does. Bun imports the SOURCE file directly (no build step):
// the package.json exports["./tui"] points at src/tui-entry.tsx, bun
// transpiles via the package's tsconfig (jsx=react-jsx,
// jsxImportSource=@opentui/solid), the imports resolve from
// clients/opencode/node_modules.
//
// This harness is the verification surface for the slot-render
// architecture. It verifies:
//   (1) bun can import the .tsx via the package.json exports
//   (2) the default export shape matches TuiPluginModule
//   (3) tui() runs without throwing
//   (4) api.slots.register is called with both home_prompt_right +
//       session_prompt_right
//   (5) URGENT FIX: each slot fn's JSX ACTUALLY MOUNTS through a real
//       @opentui/solid renderer (via `testRender`) without throwing.
//
// (5) replaces a previous, weaker version of this file that explicitly
// SKIPPED invoking the slot fns ("would need a mock renderer context —
// host provides it in production"). That was true for the plain
// @opentui/core test renderer, but @opentui/solid exports its OWN
// `testRender(node, config)` which stands up a real RendererContext +
// solid root — the same reconciler the host uses. Skipping this step is
// exactly how a real bug slipped past every other check in this repo:
// `<Show when={...} keyed>` with no `fallback` throws an "Orphan text
// error" under the installed @opentui/solid reconciler the FIRST time its
// condition is false (e.g. GhostComponent when no ghost is showing, or the
// status-line Show before any check has produced text) — the common case
// on almost every mount. vitest never renders through the real
// reconciler (card-spec.test.ts et al. only inspect plain data), so this
// was invisible to `npx vitest run`. The host's per-slot
// `pluginFailurePlaceholder` catches the throw and keeps the TUI alive,
// but the panel/ghost/status line then silently fails to render on that
// mount — plausibly the mechanism behind the "confusion half the time"
// symptom users reported. See tui-entry.tsx's `fallback={<box .../>}` on
// every `<Show>` for the fix.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { testRender } from "@opentui/solid";
import type { TestRendererSetup } from "@opentui/core/testing";

const _packageDir = resolve(import.meta.dirname, "..");
const tuiEntry = resolve(import.meta.dirname, "../src/tui-entry.tsx");
const tuiEntryUrl = pathToFileURL(tuiEntry).href;

console.log("smoke: importing", tuiEntryUrl);
let mod: { default?: { id?: string; tui?: unknown } };
try {
    mod = (await import(tuiEntryUrl)) as { default?: { id?: string; tui?: unknown } };
} catch (e) {
    console.error("FAIL: bun could not import src/tui-entry.tsx directly:", e);
    console.error(
        "HINT: the host loads this via package.json exports[./tui]; bun's transform handles the .tsx. If this fails, check that pnpm install populated node_modules/@opentui/solid and node_modules/solid-js.",
    );
    process.exit(1);
}
const plugin = mod.default;
if (!plugin || typeof plugin.tui !== "function") {
    console.error("FAIL: default export shape invalid", {
        hasDefault: !!plugin,
        hasTui: typeof plugin?.tui,
    });
    process.exit(1);
}
console.log("smoke: default export shape OK", { id: plugin.id, hasTui: typeof plugin.tui });

const slotRegistrations: Array<{
    pluginObject: { slots: Record<string, (ctx: unknown, props: unknown) => unknown> };
}> = [];

const fakeApi: Record<string, unknown> = {
    prompt: {
        ref: () => ({
            text: "I has a apple",
            current: { input: "I has a apple", parts: [] },
            cursorOffset: 2,
            offsetToScreen: (_offset: number) => ({ x: 10, y: 20 }),
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => "I has a apple".slice(s, e),
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
        register: (pluginObj: {
            slots: Record<string, (ctx: unknown, props: unknown) => unknown>;
        }) => {
            slotRegistrations.push({ pluginObject: pluginObj });
            return "smoke-slot-id";
        },
    },
};

console.log("smoke: starting plugin");
try {
    await (plugin.tui as (api: unknown) => Promise<void>)(fakeApi);
} catch (e) {
    console.error("FAIL: plugin.tui() threw:", e);
    process.exit(1);
}
console.log("smoke: plugin started OK");

if (slotRegistrations.length < 1) {
    console.error("FAIL: expected at least 1 slot registration; got", slotRegistrations.length);
    process.exit(1);
}
// All registrations should share the same plugin object; we just
// need at least one with both home_prompt_right + session_prompt_right.
let found = false;
for (const reg of slotRegistrations) {
    const names = Object.keys(reg.pluginObject.slots).sort();
    if (JSON.stringify(names) === JSON.stringify(["home_prompt_right", "session_prompt_right"])) {
        found = true;
        break;
    }
}
if (!found) {
    console.error("FAIL: no registration has both home_prompt_right + session_prompt_right");
    process.exit(1);
}
const firstReg = slotRegistrations[0]!.pluginObject;
const firstNames = Object.keys(firstReg.slots).sort();
console.log(
    "smoke: registered slots (first registration):",
    firstNames,
    "total registrations:",
    slotRegistrations.length,
);

// ── Mount each slot fn through a REAL @opentui/solid renderer ──────────
// This is the step the previous version of this file explicitly skipped.
// A thrown error here (synchronous, during mount) means the slot silently
// fails to render in production — see the file header.
for (const slotName of ["home_prompt_right", "session_prompt_right"] as const) {
    const slotFn = firstReg.slots[slotName];
    if (typeof slotFn !== "function") {
        console.error(`FAIL: slot "${slotName}" is not a function`);
        process.exit(1);
    }
    for (const dims of [
        { width: 80, height: 24, label: "80x24 (typical)" },
        { width: 0, height: 0, label: "0x0 (degenerate — new-session-mount race)" },
    ]) {
        try {
            const setup: TestRendererSetup = await testRender(
                () => slotFn({ theme: {} }) as never,
                { width: dims.width, height: dims.height },
            );
            await setup.renderOnce();
            console.log(`smoke: slot "${slotName}" mounted OK @ ${dims.label}`);
        } catch (e) {
            console.error(
                `FAIL: slot "${slotName}" threw while mounting/rendering @ ${dims.label}:`,
                e,
            );
            process.exit(1);
        }
    }
}

console.log(
    "\nsmoke: PASS — tui entry imports via package exports, registers both slots, and BOTH slot fns mount + render through a real @opentui/solid renderer (typical + degenerate 0x0 dimensions) without throwing",
);
process.exit(0);
