// Render the per-rect translucent highlight nodes inside a shadow root. One
// position:fixed node per getClientRects() rect (a wrapped line = two rects =
// two nodes). The category colour is set per-node via the `--gf-hl` custom
// property; the visible alpha is driven by intensity classes (default / focus
// / hover), all in styles.ts.
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
    node.className = 'gf-highlight'
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
    node.classList.toggle('gf-highlight--focus', state.focused)
    const idx = Number(node.dataset.item)
    node.classList.toggle('gf-highlight--hover', state.hoverItemIndex === idx)
}

export interface HighlightLayer {
    /** Diff the flat spec list against the pooled nodes; update in place. */
    reconcile: (specs: readonly HighlightSpec[]) => void
    /** Flip focus/hover intensity classes on every pooled node (no rebuild). */
    setState: (state: HighlightLayerState) => void
    /** Briefly flash the applied-flourish class on the node(s) for an item
     *  index (the fix was just applied). The class auto-removes after the
     *  animation; the next reconcile is unaffected. No-op if the index has no
     *  node. */
    flashApplied: (itemIndex: number) => void
    /** Remove every pooled node. */
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
        flashApplied(itemIndex) {
            for (const n of pool) {
                if (Number(n.dataset.item) !== itemIndex) continue
                n.classList.add('gf-highlight--applied')
                const clear = (): void => n.classList.remove('gf-highlight--applied')
                n.addEventListener('animationend', clear, { once: true })
            }
        },
        destroy() {
            for (const n of pool) n.remove()
            pool.length = 0
        },
    }
}
