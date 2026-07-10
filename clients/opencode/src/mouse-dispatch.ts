// mouse-dispatch.ts — pure mouse click/scroll → callback dispatch matrix for
// the floating card (P1-6).
//
// This logic previously lived entirely inline inside tui-entry.tsx's JSX
// (onMouseDown/onMouseScroll closures on the card box, each row box, and
// each segment text node) — untestable without spinning up @opentui/solid.
// Extracting it here makes tui-entry.tsx a thin caller: given the click/
// scroll TARGET (card body / a specific row / a specific segment) and the
// current card's kind + alt-total, these pure functions resolve WHICH
// callback should fire; `runDispatchedAction` then calls it against the
// panel controller. Every mapping mirrors opencode-interaction.md §4's mouse
// table and §8's checklist — same keyboard-equivalent semantics, just moved
// out of JSX so the matrix is unit-testable.

export type CardKind = "suggestion" | "rephrase-loading" | "rephrase-result";

export type ScrollDirection = "up" | "down";

export type SegmentAction = "apply" | "ignore" | undefined;

/** The resolved action a click/scroll should trigger, or null for a no-op
 *  (the click/scroll falls through with no effect). */
export type DispatchedAction =
    | "apply"
    | "ignore"
    | "rephraseAccept"
    | "rephraseCycleNext"
    | "rephraseScrollUp"
    | "rephraseScrollDown"
    | null;

/** The subset of PanelController the dispatcher needs to fire an action.
 *  Structurally compatible with PanelController (details-panel-view.ts) —
 *  any object with these optional callbacks works, so tests don't need the
 *  full controller shape. */
export interface MouseDispatchControllerLike {
    onApply?: () => void;
    onIgnore?: () => void;
    onRephraseAccept?: () => void;
    onRephraseCycleNext?: () => void;
    onRephraseScrollUp?: () => void;
    onRephraseScrollDown?: () => void;
}

/**
 * Click on the card BODY (no more specific row/segment target matched, or
 * the click bubbled up from a spot with no discrete action). Mirrors
 * `return`: apply the pinned suggestion, or accept the rephrase result.
 * `rephrase-loading` has nothing to accept — no-op.
 */
export function dispatchCardClick(kind: CardKind): DispatchedAction {
    if (kind === "suggestion") return "apply";
    if (kind === "rephrase-result") return "rephraseAccept";
    return null;
}

/**
 * Wheel-scroll over the card body. Mirrors PgUp/PgDn — only the
 * rephrase-result body can overflow and scroll (§5); every other kind is a
 * no-op.
 */
export function dispatchCardScroll(kind: CardKind, direction: ScrollDirection): DispatchedAction {
    if (kind !== "rephrase-result") return null;
    return direction === "up" ? "rephraseScrollUp" : "rephraseScrollDown";
}

/**
 * Click on a specific ROW (not a specific segment within it). Only row 0
 * (the title row, where the `‹ k/n ›` alternative indicator renders — see
 * card-spec.ts buildRephraseResultCardSpec) cycles to the next alternative,
 * and only when there's more than one alternative to cycle through.
 */
export function dispatchRowClick(
    kind: CardKind,
    rowIndex: number,
    altTotal: number,
): DispatchedAction {
    if (kind === "rephrase-result" && rowIndex === 0 && altTotal > 1) {
        return "rephraseCycleNext";
    }
    return null;
}

/**
 * Click on a specific SEGMENT carrying an explicit `action` (the suggestion
 * card's discrete "⏎ apply" / "x ignore" clickable hint spans — see
 * card-spec.ts's `SegmentAction`). Segments without an action resolve to
 * null so the click falls through to the card's default (dispatchCardClick).
 */
export function dispatchSegmentClick(action: SegmentAction): DispatchedAction {
    if (action === "apply") return "apply";
    if (action === "ignore") return "ignore";
    return null;
}

/** Fire the resolved action against the controller-like bag of callbacks.
 *  A null action (no match) is a deliberate no-op. */
export function runDispatchedAction(
    action: DispatchedAction,
    controller: MouseDispatchControllerLike,
): void {
    switch (action) {
        case "apply":
            controller.onApply?.();
            break;
        case "ignore":
            controller.onIgnore?.();
            break;
        case "rephraseAccept":
            controller.onRephraseAccept?.();
            break;
        case "rephraseCycleNext":
            controller.onRephraseCycleNext?.();
            break;
        case "rephraseScrollUp":
            controller.onRephraseScrollUp?.();
            break;
        case "rephraseScrollDown":
            controller.onRephraseScrollDown?.();
            break;
        case null:
            break;
    }
}
