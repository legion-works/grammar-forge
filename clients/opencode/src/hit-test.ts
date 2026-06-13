// Pure hit-test helper extracted from the orchestrator's onCursorMove
// so the end-inclusive contract is unit-testable without spinning up
// the full orchestrator. The orchestrator used to inline this loop;
// extracting it here gives us:
//   (1) one source of truth for the hit-test math,
//   (2) a pure function shape: given (offset, spans) return the
//       match index or null.
//
// CONTRACT (post-fix): END-INCLUSIVE. offset >= displayStart &&
// offset <= displayEnd pins that span. The pre-fix contract was
// offset < displayEnd (end-exclusive) which rejected word-end
// clicks. On a shared boundary offset == end of span A == start of
// adjacent span B, the LEFT span (A) wins because the loop is
// first-match-wins over ascending starts (the orchestrator
// maintains a stable sort).
//
// Spans must be sorted by ascending start for the left-wins
// guarantee to hold. The orchestrator's items are in pipeline
// order (stable).

export interface HitTestSpan {
    start: number;
    end: number;
}

export function hitTestEndInclusive(
    offset: number,
    spans: ReadonlyArray<HitTestSpan>,
): number | null {
    for (let i = 0; i < spans.length; i++) {
        const s = spans[i]!;
        if (offset >= s.start && offset <= s.end) {
            return i;
        }
    }
    return null;
}
