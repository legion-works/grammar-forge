import { build } from "esbuild";
import { resolve } from "node:path";

await build({
  entryPoints: [resolve(import.meta.dirname, "../src/index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  outfile: resolve(import.meta.dirname, "../dist/index.js"),
  alias: { "@": resolve(import.meta.dirname, "../../browser/src") },
});
console.log("built dist/index.js");
