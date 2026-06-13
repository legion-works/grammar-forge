// Pin-state for the suggestion-details panel. Pure closure factory: no
// framework deps, no I/O, fully deterministic — the only side effect is
// notifying subscribers, and that fanout is intentional. The orchestrator
// owns the lifecycle; this module is the model.
//
// Design notes:
//   - Wrap math uses ((value % n) + n) % n so negative directions
//     (cycle(-1, n)) land in [0, n) without a special case. From a
//     current pin `p`, direction +1 lands on (p+1) % n, direction -1
//     lands on (p-1+n) % n.
//   - itemsChanged: pin index out of [0, itemCount) → null. Keeps a
//     still-valid pin silently (no subscriber fire, no transition).
//   - itemsChanged with a signature array: identity-swap detection —
//     if the pin's previous signature != the new signature at the
//     same index, the pin is stale. Clears (and fires).
//   - subscribe: one fire per state TRANSITION. Pin/unpin/cycle/itemsChanged-
//     that-cleared all fire. No-op cases (unpin-when-null, double-pin,
//     cycle-when-null, cycle-when-0, itemsChanged-keeps) do NOT fire.

export type DetailsState = {
    pinnedIndex: () => number | null;
    pin: (index: number) => void;
    unpin: () => void;
    cycle: (direction: 1 | -1, itemCount: number) => void;
    /** Called on every items refresh. The optional `signatures` array
     *  enables identity-swap detection: if `signatures[pinIndex]` differs
     *  from the previously-snapshotted signature at the same index, the
     *  pin is cleared (treated as stale even though the count is valid). */
    itemsChanged: (itemCount: number, signatures?: ReadonlyArray<string>) => void;
    subscribe: (callback: () => void) => () => void;
};

export function createDetailsState(): DetailsState {
    let currentPin: number | null = null;
    let currentSignature: string | null = null;
    const subscribers = new Set<() => void>();

    const notify = (): void => {
        for (const callback of subscribers) {
            callback();
        }
    };

    return {
        pinnedIndex: () => currentPin,
        pin: (index) => {
            if (currentPin === index) return;
            currentPin = index;
            currentSignature = null; // caller didn't pass a signature; reset
            notify();
        },
        unpin: () => {
            if (currentPin === null) return;
            currentPin = null;
            currentSignature = null;
            notify();
        },
        cycle: (direction, itemCount) => {
            if (itemCount <= 0) return;
            if (currentPin === null) return;
            const wrapped = (((currentPin + direction) % itemCount) + itemCount) % itemCount;
            if (wrapped === currentPin) return;
            currentPin = wrapped;
            currentSignature = null; // cycle doesn't pass a signature; reset
            notify();
        },
        itemsChanged: (itemCount, signatures) => {
            if (currentPin === null) return;
            if (currentPin >= itemCount) {
                // Pin is out of range — clear.
                currentPin = null;
                currentSignature = null;
                notify();
                return;
            }
            // Pin is in range. If a signature was provided for the
            // pinned index AND it differs from the previous signature,
            // the pin is stale (re-check produced different content
            // for the same index) — clear.
            if (signatures && currentPin < signatures.length) {
                const nextSignature = signatures[currentPin] ?? null;
                if (
                    currentSignature !== null &&
                    nextSignature !== null &&
                    currentSignature !== nextSignature
                ) {
                    currentPin = null;
                    currentSignature = null;
                    notify();
                    return;
                }
                currentSignature = nextSignature;
            }
            // Otherwise: still-valid pin, no transition, no fire.
        },
        subscribe: (callback) => {
            subscribers.add(callback);
            return () => {
                subscribers.delete(callback);
            };
        },
    };
}
