// Thin wrapper around the shared File debug-log backend. Activated
// only when GF_TUI_DEBUG=1; zero overhead when unset (env read is
// the only check; no I/O if the flag is missing). Used by the
// tui-entry + orchestrator to emit one-line breadcrumbs to
// /tmp/grammarforge-tui-debug.log so the next live run produces
// evidence no matter what.
//
// Output format: ISO-8601 timestamp + "|" + level + "|" +
// scope:message + "|" + JSON-encoded args. Pure append — does not
// rotate, does not fsync. On write error, swallow silently (we never
// want the debug path to throw into a render fn).

import { createFileBackend } from "@/lib/debug-backends";
// node: builtins resolve in Bun regardless of --conditions (the host
// launches with --conditions=browser, under which globalThis.require is
// undefined → the default createFileBackend append silently no-ops and
// NO debug output is ever written). Import appendFileSync statically and
// inject it so GF_TUI_DEBUG actually produces a log under the host runtime.
import { appendFileSync } from "node:fs";

let enabled = false;
let path = "/tmp/grammarforge-tui-debug.log";
try {
    if (process.env["GF_TUI_DEBUG"] === "1") {
        enabled = true;
        if (
            typeof process.env["GF_TUI_DEBUG_PATH"] === "string" &&
            process.env["GF_TUI_DEBUG_PATH"] !== ""
        ) {
            path = process.env["GF_TUI_DEBUG_PATH"];
        }
    }
} catch {
    // process.env may be unavailable in some test runners. Default
    // to disabled.
    enabled = false;
}

const backend = createFileBackend({
    path,
    isEnabled: () => enabled,
    // Inject a working append — the default path uses globalThis.require,
    // which is undefined under the host's --conditions=browser launch.
    append: (p, line) => {
        appendFileSync(p, line, "utf8");
    },
});

export function logDebug(message: string, args?: unknown): void {
    if (!enabled) return;
    backend.log("info", "", message, args);
}

export function logDebugError(message: string, err: unknown): void {
    if (!enabled) return;
    const e =
        err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack ?? "" }
            : { value: String(err) };
    backend.log("error", "", message, e);
}
