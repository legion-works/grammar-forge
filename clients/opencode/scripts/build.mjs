// The tui entry is now source-shipped (src/tui-entry.tsx, pointed at
// by package.json exports["./tui"]). The host loads it directly via
// bun's runtime transform; no esbuild bundle is needed for the TUI
// surface. We keep this script as a no-op so existing pnpm build
// invocations don't fail — it intentionally produces nothing.
//
// If a future task needs a CI sanity check (typecheck the entry,
// verify the imports resolve), add that logic here WITHOUT
// emitting dist/ — the loader path is source-only.
//
// Reference: anthropic-auth/packages/opencode exports["./tui"] →
// "./src/tui.tsx" with bun:transform. Their build script
// (scripts.build in package.json) bundles dist/{index,cli,...}.ts
// but explicitly ships src/tui.tsx uncompiled.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJsonPath = resolve(import.meta.dirname, "../package.json");
const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const tuiExport = pkg.exports?.["./tui"]?.import;

if (!tuiExport) {
  console.error("build: no exports['.\\/tui'].import in package.json — tui entry missing");
  process.exit(1);
}

const tuiPath = resolve(import.meta.dirname, "..", tuiExport);
if (!existsSync(tuiPath)) {
  console.error(`build: tui entry not found at ${tuiPath}`);
  process.exit(1);
}

console.log(`build: source-shipped tui entry verified at ${tuiExport}`);
console.log("build: no bundle to produce — the host loads src/tui-entry.tsx via bun:transform");
