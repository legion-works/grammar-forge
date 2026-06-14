// Render the per-rect translucent highlight nodes inside a shadow root. One
// position:fixed node per getClientRects() rect (a wrapped line = two rects =
// two nodes). The category colour is set per-node via the `--gf-hl` custom
// property; the visible alpha is driven by the `.is-on` class (the design
// system's hover/active indicator), all in styles.ts.
//
// The highlight is PURELY VISUAL: it is pointer-events:none (see styles.ts) and
// installs no listeners. Hover/click interaction is detected on the FIELD
// itself by the content orchestrator (which hit-tests the pointer against the
// edit rects), so the overlay never blocks the page's typing, caret placement,
// or text selection.
import { CATEGORY_META } from '@/api/category'
import type { Category } from '@/api/types'

export interface HighlightSpec {
    rect: DOMRect
    category: Category
    /** Index of the owning RenderableItem (for per-word hover intensity). */
    itemIndex: number
}

export interface HighlightLayerState {
    focused: boolean
    hoverItemIndex: number | null
}

function styleHighlightNode(node: HTMLDivElement, spec: HighlightSpec): void {
    if (node.getAttribute('aria-hidden') !== 'true') node.setAttribute('aria-hidden', 'true')
    // `.gf-u` = the design-system underline class. The category modifier
    // (`.gf-u--<cat>`) drives the underline colour via CSS custom property;
    // the `.is-on` modifier (toggled by applyState below) drives the
    // background tint on hover / when the card for that item is open. The
    // base state is INTENTIONALLY tint-free — the underline is the resting
    // visual marker.
    node.className = `gf-u gf-u--${spec.category}`
    node.dataset.item = String(spec.itemIndex)
    if (spec.rect.width <= 0 || spec.rect.height <= 0) {
        node.style.display = 'none'
        return
    }
    node.style.display = ''
    node.style.setProperty('--gf-hl', CATEGORY_META[spec.category].tint)
    node.style.left = `${spec.rect.left}px`
    node.style.top = `${spec.rect.top}px`
    node.style.width = `${Math.max(spec.rect.width, 4)}px`
    node.style.height = `${spec.rect.height}px`
}

function applyState(node: HTMLDivElement, state: HighlightLayerState): void {
    // `.is-on` = hover or the card is open. The field-level "focused" flag
    // bumps every node into `.is-on` (the whole field is highlighted when
    // it has focus, matching the design system spec). A specific
    // hoverItemIndex also forces `.is-on` for just that item's rect-nodes.
    const idx = Number(node.dataset.item)
    const isOn = state.focused || state.hoverItemIndex === idx
    node.classList.toggle('is-on', isOn)
}

export interface HighlightLayer {
    /** Diff the flat spec list against the pooled nodes; update in place. */
    reconcile: (specs: readonly HighlightSpec[]) => void
    /**
     * Restyle EVERY rect-node of the targeted item in place, by itemIndex.
     * The pool is indexed by RECT, not by item (a wrapped word produces
     * multiple getClientRects() — multiple pool nodes sharing one data-item
     * attribute), so we look up by `data-item` matching the existing
     * `flashApplied` pattern. Nodes for other items are not touched (no
     * rebuild, no remeasure). `partial` carries the new rect + category.
     * No-op when no pool node has a matching data-item. Consumed by the
     * P3/P4 performance plan (single-item reanchor without a full
     * reconcile).
     */
    updateItem: (itemIndex: number, partial: Omit<HighlightSpec, 'itemIndex'>) => void
    /**
     * Hide EVERY rect-node of the targeted item (display:none via a
     * zero-area rect), matching by `data-item`. The nodes are NOT removed
     * from the pool — a subsequent reconcile with that itemIndex still
     * maps to these nodes. No-op when no pool node has a matching
     * data-item. Consumed by the per-item scoped clear + the P3/P4 perf
     * reanchor.
     */
    clearItem: (itemIndex: number) => void
    /** Flip focus/hover intensity classes on every pooled node (no rebuild). */
    setState: (state: HighlightLayerState) => void
    flashApplied: (itemIndex: number) => void
    destroy: () => void
}

/**
 * A reconciling highlight layer: owns ONE flat pool of nodes and updates it in
 * place on each reconcile (grow/shrink + restyle/reposition) instead of the
 * destroy-and-recreate that flickered. Nodes are interchangeable: a node's
 * category/colour/position are set per reconcile, so the same DOM node
 * survives across checks when the count is stable. Intensity (focus/hover) is
 * a CSS-class flip on the existing nodes, applied via `setState` — no DOM
 * churn for the common (no-reconcile) focus/blur/mousemove paths.
 */
export function createHighlightLayer(root: ShadowRoot): HighlightLayer {
    const pool: HTMLDivElement[] = []
    let lastState: HighlightLayerState = { focused: false, hoverItemIndex: null }
    return {
        reconcile(specs) {
            while (pool.length > specs.length) pool.pop()!.remove()
            while (pool.length < specs.length) {
                const n = root.ownerDocument.createElement('div')
                root.appendChild(n)
                pool.push(n)
            }
            for (let i = 0; i < specs.length; i++) {
                styleHighlightNode(pool[i]!, specs[i]!)
                applyState(pool[i]!, lastState)
            }
        },
        setState(state) {
            const prev = lastState
            lastState = state
            // focused changed → must re-apply to all nodes (every highlight for
            // this field gains/loses focus intensity).
            if (state.focused !== prev.focused) {
                for (const n of pool) applyState(n, state)
                return
            }
            // only hover changed → toggle just the old + new hovered nodes.
            if (state.hoverItemIndex !== prev.hoverItemIndex) {
                for (const n of pool) {
                    const idx = Number(n.dataset.item)
                    if (idx === prev.hoverItemIndex || idx === state.hoverItemIndex)
                        applyState(n, state)
                }
            }
        },
        updateItem(itemIndex, partial) {
            for (const node of pool) {
                if (Number(node.dataset.item) !== itemIndex) continue
                styleHighlightNode(node, { ...partial, itemIndex })
                applyState(node, lastState)
            }
        },
        clearItem(itemIndex) {
            for (const node of pool) {
                if (Number(node.dataset.item) !== itemIndex) continue
                // styleHighlightNode already handles width/height <= 0 by
                // setting display:none — the cheapest "hide" without
                // changing data-item (so a later reconcile / updateItem
                // with the same itemIndex re-uses this exact node).
                styleHighlightNode(node, {
                    rect: new DOMRect(0, 0, 0, 0),
                    category: 'spelling',
                    itemIndex,
                })
                applyState(node, lastState)
            }
        },
        flashApplied(itemIndex) {
            for (const n of pool) {
                if (Number(n.dataset.item) !== itemIndex) continue
                n.classList.add('gf-u--applied')
                const clear = (): void => n.classList.remove('gf-u--applied')
                n.addEventListener('animationend', clear, { once: true })
            }
        },
        destroy() {
            for (const n of pool) n.remove()
            pool.length = 0
        },
    }
}
