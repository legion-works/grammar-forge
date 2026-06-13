// Headless smoke harness — exercise the tui entry the way the opencode
// host does. Bun imports the SOURCE file directly (no build step):
// the package.json exports["./tui"] points at src/tui-entry.tsx, bun
// transpiles via the package's tsconfig (jsx=react-jsx,
// jsxImportSource=@opentui/solid), the imports resolve from
// clients/opencode/node_modules.
//
// This harness is the verification surface for the slot-render
// architecture. It does NOT verify the bundled dist (we no longer
// ship a tui.js bundle — the host loads source directly). It DOES
// verify:
//   (1) bun can import the .tsx via the package.json exports
//   (2) the default export shape matches TuiPluginModule
//   (3) tui() runs without throwing
//   (4) api.slots.register is called with both home_prompt_right +
//       session_prompt_right
//
// The slot fn body itself uses JSX (createElement for opentui
// elements, Show for visibility) which is a Bun-only construct.
// Calling the fn in this harness requires the host's renderer
// context; we don't try. The contract is encoded in the source
// and the maintainer's live smoke is the final verification.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
const firstNames = Object.keys(slotRegistrations[0]!.pluginObject.slots).sort();
console.log(
    "smoke: registered slots (first registration):",
    firstNames,
    "total registrations:",
    slotRegistrations.length,
);
const _expected = ["home_prompt_right", "session_prompt_right"];
console.log(
    "smoke: registered slots (first registration):",
    firstNames,
    "total registrations:",
    slotRegistrations.length,
);

// We do NOT call the slot fns. The slot fn body uses JSX with
// @opentui/solid, which requires the host's renderer context.
// Invoking here would throw "No renderer found". The contract is
// that the slot fn returns the PanelComponent JSX, which bun's
// runtime JSX transform resolves to opentui's createElement
// calls; the host's renderer context is provided when the host
// calls the slot fn in production.
console.log(
    "smoke: skipping slot fn invocation — would need a mock renderer context (host provides it in production)",
);

console.log(
    "smoke: PASS — tui entry imports via package exports, registers both slots, contract encoded in source",
);
process.exit(0);
