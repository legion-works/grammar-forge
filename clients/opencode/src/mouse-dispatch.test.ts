import { describe, expect, test, vi } from "vitest";
import {
    dispatchCardClick,
    dispatchCardScroll,
    dispatchRowClick,
    dispatchSegmentClick,
    runDispatchedAction,
    type CardKind,
} from "./mouse-dispatch";

const KINDS: CardKind[] = ["suggestion", "rephrase-loading", "rephrase-result"];

describe("dispatchCardClick", () => {
    test("suggestion → apply", () => {
        expect(dispatchCardClick("suggestion")).toBe("apply");
    });
    test("rephrase-result → rephraseAccept", () => {
        expect(dispatchCardClick("rephrase-result")).toBe("rephraseAccept");
    });
    test("rephrase-loading → no-op (null)", () => {
        expect(dispatchCardClick("rephrase-loading")).toBeNull();
    });
});

describe("dispatchCardScroll", () => {
    test("rephrase-result + up → rephraseScrollUp", () => {
        expect(dispatchCardScroll("rephrase-result", "up")).toBe("rephraseScrollUp");
    });
    test("rephrase-result + down → rephraseScrollDown", () => {
        expect(dispatchCardScroll("rephrase-result", "down")).toBe("rephraseScrollDown");
    });
    test("suggestion (any direction) → no-op", () => {
        expect(dispatchCardScroll("suggestion", "up")).toBeNull();
        expect(dispatchCardScroll("suggestion", "down")).toBeNull();
    });
    test("rephrase-loading (any direction) → no-op", () => {
        expect(dispatchCardScroll("rephrase-loading", "up")).toBeNull();
        expect(dispatchCardScroll("rephrase-loading", "down")).toBeNull();
    });
});

describe("dispatchRowClick", () => {
    test("rephrase-result, row 0, altTotal > 1 → rephraseCycleNext", () => {
        expect(dispatchRowClick("rephrase-result", 0, 2)).toBe("rephraseCycleNext");
        expect(dispatchRowClick("rephrase-result", 0, 3)).toBe("rephraseCycleNext");
    });
    test("rephrase-result, row 0, altTotal === 1 (no alternatives) → no-op", () => {
        expect(dispatchRowClick("rephrase-result", 0, 1)).toBeNull();
    });
    test("rephrase-result, non-title row (rowIndex > 0) → no-op regardless of altTotal", () => {
        expect(dispatchRowClick("rephrase-result", 1, 3)).toBeNull();
        expect(dispatchRowClick("rephrase-result", 2, 3)).toBeNull();
    });
    test("suggestion / rephrase-loading kinds never cycle alternatives", () => {
        expect(dispatchRowClick("suggestion", 0, 3)).toBeNull();
        expect(dispatchRowClick("rephrase-loading", 0, 3)).toBeNull();
    });
});

describe("dispatchSegmentClick", () => {
    test("action='apply' → apply", () => {
        expect(dispatchSegmentClick("apply")).toBe("apply");
    });
    test("action='ignore' → ignore", () => {
        expect(dispatchSegmentClick("ignore")).toBe("ignore");
    });
    test("action=undefined (no discrete action) → no-op, falls through to card default", () => {
        expect(dispatchSegmentClick(undefined)).toBeNull();
    });
});

describe("runDispatchedAction", () => {
    const makeSpyController = () => ({
        onApply: vi.fn(),
        onIgnore: vi.fn(),
        onRephraseAccept: vi.fn(),
        onRephraseCycleNext: vi.fn(),
        onRephraseScrollUp: vi.fn(),
        onRephraseScrollDown: vi.fn(),
    });

    test("'apply' fires ONLY controller.onApply", () => {
        const ctrl = makeSpyController();
        runDispatchedAction("apply", ctrl);
        expect(ctrl.onApply).toHaveBeenCalledTimes(1);
        expect(ctrl.onIgnore).not.toHaveBeenCalled();
        expect(ctrl.onRephraseAccept).not.toHaveBeenCalled();
        expect(ctrl.onRephraseCycleNext).not.toHaveBeenCalled();
        expect(ctrl.onRephraseScrollUp).not.toHaveBeenCalled();
        expect(ctrl.onRephraseScrollDown).not.toHaveBeenCalled();
    });

    test("'ignore' fires ONLY controller.onIgnore", () => {
        const ctrl = makeSpyController();
        runDispatchedAction("ignore", ctrl);
        expect(ctrl.onIgnore).toHaveBeenCalledTimes(1);
        expect(ctrl.onApply).not.toHaveBeenCalled();
    });

    test("'rephraseAccept' fires ONLY controller.onRephraseAccept", () => {
        const ctrl = makeSpyController();
        runDispatchedAction("rephraseAccept", ctrl);
        expect(ctrl.onRephraseAccept).toHaveBeenCalledTimes(1);
        expect(ctrl.onApply).not.toHaveBeenCalled();
    });

    test("'rephraseCycleNext' fires ONLY controller.onRephraseCycleNext", () => {
        const ctrl = makeSpyController();
        runDispatchedAction("rephraseCycleNext", ctrl);
        expect(ctrl.onRephraseCycleNext).toHaveBeenCalledTimes(1);
    });

    test("'rephraseScrollUp' / 'rephraseScrollDown' fire the matching callback only", () => {
        const ctrl1 = makeSpyController();
        runDispatchedAction("rephraseScrollUp", ctrl1);
        expect(ctrl1.onRephraseScrollUp).toHaveBeenCalledTimes(1);
        expect(ctrl1.onRephraseScrollDown).not.toHaveBeenCalled();

        const ctrl2 = makeSpyController();
        runDispatchedAction("rephraseScrollDown", ctrl2);
        expect(ctrl2.onRephraseScrollDown).toHaveBeenCalledTimes(1);
        expect(ctrl2.onRephraseScrollUp).not.toHaveBeenCalled();
    });

    test("null action fires nothing", () => {
        const ctrl = makeSpyController();
        runDispatchedAction(null, ctrl);
        for (const fn of Object.values(ctrl)) {
            expect(fn).not.toHaveBeenCalled();
        }
    });

    test("missing callback on the controller does not throw (graceful degradation)", () => {
        expect(() => runDispatchedAction("apply", {})).not.toThrow();
        expect(() => runDispatchedAction("rephraseScrollUp", {})).not.toThrow();
    });
});

describe("full dispatch matrix — every (kind × gesture) combination", () => {
    // A compact table-driven sanity sweep so a future kind/gesture addition
    // that silently breaks an existing mapping shows up here.
    test("card click matrix", () => {
        const expected: Record<CardKind, ReturnType<typeof dispatchCardClick>> = {
            suggestion: "apply",
            "rephrase-loading": null,
            "rephrase-result": "rephraseAccept",
        };
        for (const kind of KINDS) {
            expect(dispatchCardClick(kind)).toBe(expected[kind]);
        }
    });

    test("card scroll matrix (both directions)", () => {
        for (const kind of KINDS) {
            const up = dispatchCardScroll(kind, "up");
            const down = dispatchCardScroll(kind, "down");
            if (kind === "rephrase-result") {
                expect(up).toBe("rephraseScrollUp");
                expect(down).toBe("rephraseScrollDown");
            } else {
                expect(up).toBeNull();
                expect(down).toBeNull();
            }
        }
    });
});
