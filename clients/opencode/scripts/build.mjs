import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const distDir = resolve(import.meta.dirname, "../dist");

// Wipe dist before re-emitting: stale files from a prior build (in
// particular an old dist/index.js) must NOT linger. See the comment on
// the manifest below for why dist/index.js is a hard error.
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

await build({
  entryPoints: [resolve(import.meta.dirname, "../src/index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  outfile: resolve(distDir, "tui.js"),
  alias: { "@": resolve(import.meta.dirname, "../../browser/src") },
});

// OpenCode's plugin loader iterates the config `plugin` array for BOTH
// server and tui kinds. For FILE plugins the server-kind resolver falls
// back to the directory INDEX_FILES list (index.ts/tsx/js/mjs/cjs) EVEN
// when package.json exports exist (packages/opencode/src/plugin/shared.ts
// lines 158-165). If the dist directory contains any index.* file, the
// server loader imports it and throws "must default export an object
// with server()" before the tui kind gets a clean shot.
//
// Fix: name the bundle dist/tui.js (NOT index.*) and map exports["./tui"]
// to it. The server loader then fails to resolve a server entry, logs
// "does not expose a server entrypoint", and the tui loader resolves
// "./tui" via exports. The `oc-plugin: ['tui']` metadata field lists
// the supported kinds.
//
// Also: rmSync at the top of this script guarantees no stale index.js
// from a previous build can survive — the directory-index fallback
// would otherwise still find it.
const pluginManifest = {
  name: "grammarforge-opencode",
  type: "module",
  "oc-plugin": ["tui"],
  exports: { "./tui": "./tui.js" },
};
writeFileSync(
  resolve(distDir, "package.json"),
  JSON.stringify(pluginManifest, null, 2) + "\n",
  "utf8",
);

console.log("built dist/tui.js");
console.log("built dist/package.json");
