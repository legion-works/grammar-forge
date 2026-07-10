import { describe, expect, test } from "vitest";
import { detectTerminalTheme, parseColorFgBg } from "./terminal-theme";

describe("parseColorFgBg", () => {
    test("undefined → null (no signal)", () => {
        expect(parseColorFgBg(undefined)).toBeNull();
    });

    test("empty string → null", () => {
        expect(parseColorFgBg("")).toBeNull();
    });

    test("bg=0 (black) → dark", () => {
        expect(parseColorFgBg("15;0")).toBe("dark");
    });

    test("bg=15 (bright white) → light", () => {
        expect(parseColorFgBg("0;15")).toBe("light");
    });

    test("bg=7 (white) → light", () => {
        expect(parseColorFgBg("0;7")).toBe("light");
    });

    test("bg=8 (bright black / gray) → dark", () => {
        expect(parseColorFgBg("15;8")).toBe("dark");
    });

    test("three-part form (fg;bg;bg2) uses the LAST segment", () => {
        expect(parseColorFgBg("15;0;15")).toBe("light");
    });

    test("unparseable garbage → null", () => {
        expect(parseColorFgBg("not-a-number")).toBeNull();
    });
});

describe("detectTerminalTheme", () => {
    test("no themeApi, no COLORFGBG → defaults to dark", () => {
        expect(detectTerminalTheme(undefined, {})).toBe("dark");
    });

    test("no themeApi, COLORFGBG signals light → light", () => {
        expect(detectTerminalTheme(undefined, { COLORFGBG: "0;15" })).toBe("light");
    });

    test("no themeApi, COLORFGBG signals dark → dark", () => {
        expect(detectTerminalTheme(undefined, { COLORFGBG: "15;0" })).toBe("dark");
    });

    test("themeApi.background = 'light' wins over env", () => {
        expect(
            detectTerminalTheme({ background: "light" }, { COLORFGBG: "15;0" }),
        ).toBe("light");
    });

    test("themeApi.appearance = 'dark' is honored", () => {
        expect(detectTerminalTheme({ appearance: "dark-mode" }, {})).toBe("dark");
    });

    test("themeApi.mode = 'Light' (case-insensitive) is honored", () => {
        expect(detectTerminalTheme({ mode: "Light" }, {})).toBe("light");
    });

    test("themeApi present but no recognizable hint → falls back to env", () => {
        expect(detectTerminalTheme({ syntax: () => null }, { COLORFGBG: "0;15" })).toBe(
            "light",
        );
    });

    test("no themeApi hint and no env signal → dark default", () => {
        expect(detectTerminalTheme({}, {})).toBe("dark");
    });
});
