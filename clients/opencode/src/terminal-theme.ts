// terminal-theme.ts — best-effort dark/light terminal background detection.
//
// P1-4: card-spec.ts's DIM/DELETE/INSERT colors were hardcoded to the Tokyo
// Night DARK values and used directly on the terminal background (the status
// line and ghost-completion text in tui-entry.tsx render with no card/box
// behind them — they ARE the background). INSTRUCTIONS.md §E / §H: OpenCode
// "inherits the user's terminal theme" — a dim gray-blue (#828bb8) that reads
// fine on a dark background is low-contrast-to-illegible on a light one.
//
// OpenCode's plugin API (opencode-types.ts TuiApi.theme) does not expose a
// TYPED background/appearance field — `theme: { syntax?(): SyntaxStyleApi }
// & Record<string, unknown>` is deliberately permissive because the real
// host may carry fields this plugin hasn't typed. We defensively probe a
// few common property names a future build MIGHT expose (`background`,
// `appearance`, `mode`, `kind`) before falling back to the one signal most
// terminal emulators set: the COLORFGBG environment variable ("fg;bg" ANSI
// color numbers, e.g. "15;0" = white-on-black). See HARNESS.md for the
// known-gap note: neither signal is confirmed against a live patched
// OpenCode build (same "unverified" status as the rest of the live smoke
// harness).
//
// When NEITHER signal is present, default to DARK — a wrong "light" guess on
// an actually-dark terminal (unreadable dim text) is worse than staying on
// today's only verified palette.

export type TerminalTheme = "dark" | "light";

interface ThemeApiShape {
    background?: string;
    appearance?: string;
    mode?: string;
    kind?: string;
}

/**
 * Parse COLORFGBG ("fg;bg" or "fg;bg;bg2", ANSI color numbers 0-15).
 * Convention used by vim/tmux/fzf/etc: background color 7 (white) or 15
 * (bright white) → light; every other background number → dark.
 * Returns null when unset or unparseable (no signal).
 */
export function parseColorFgBg(raw: string | undefined): TerminalTheme | null {
    if (!raw) return null;
    const parts = raw.split(";");
    const bg = Number(parts[parts.length - 1]);
    if (!Number.isFinite(bg)) return null;
    return bg === 7 || bg === 15 ? "light" : "dark";
}

/**
 * Best-effort terminal theme detection.
 *
 * @param themeApi  The host's `TuiApi.theme` object (defensively probed —
 *                  see module docstring). Pass `undefined` when unavailable.
 * @param env       Environment variables to read COLORFGBG from. Defaults to
 *                  `process.env`; injectable for tests.
 */
export function detectTerminalTheme(
    themeApi?: Record<string, unknown>,
    env: Record<string, string | undefined> = typeof process !== "undefined"
        ? process.env
        : {},
): TerminalTheme {
    const shape = (themeApi ?? {}) as ThemeApiShape;
    const hint = shape.background ?? shape.appearance ?? shape.mode ?? shape.kind;
    if (typeof hint === "string") {
        const lower = hint.toLowerCase();
        if (lower.includes("light")) return "light";
        if (lower.includes("dark")) return "dark";
    }
    return parseColorFgBg(env.COLORFGBG) ?? "dark";
}
