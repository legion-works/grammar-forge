// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// Render the per-rect underline nodes inside a shadow root. One position:fixed
// node per getClientRects() rect (a wrapped line = two rects = two nodes).
//
// The underline is PURELY VISUAL: it is pointer-events:none (see styles.ts) and
// installs no listeners. Hover/click interaction is detected on the FIELD
// itself by the content orchestrator (which hit-tests the pointer against the
// edit rects), so the overlay never blocks the page's typing, caret placement,
// or text selection.
import { CATEGORY_META } from '@/api/category'
import type { Category } from '@/api/types'

// The wavy squiggle is an SVG tiled as a background image. It CANNOT use
// `stroke='currentColor'`: `currentColor` does not resolve inside a data-URI
// background (the SVG is an independent document), so the wave would paint
// black and vanish on dark pages even though the node's `color` is set. We
// bake the category colour straight into the SVG instead. The '#' in a hex
// colour must be percent-encoded (%23) or it is parsed as a URI fragment and
// breaks the data URI.
function wavyBackgroundImage(color: string): string {
    const stroke = color.replace('#', '%23')
    return (
        `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' ` +
        `width='6' height='3' viewBox='0 0 6 3'><path d='M0 2 Q 1.5 0 3 2 T 6 2' ` +
        `fill='none' stroke='${stroke}' stroke-width='1' stroke-linecap='round'/></svg>")`
    )
}

export interface UnderlineHandle {
    /** Remove every underline node this handle owns. */
    destroy: () => void
    /** The list of nodes the handle currently owns (post-render). */
    nodes: HTMLDivElement[]
}

export interface RenderUnderlinesOptions {
    /** Already-computed viewport rects (one per visual line). */
    rects: readonly DOMRect[]
    category: Category
}

export interface UnderlineSpec {
    rect: DOMRect
    category: Category
}

/** Apply per-category styling + position to one pooled node, in place. */
function styleUnderlineNode(node: HTMLDivElement, spec: UnderlineSpec): void {
    if (node.getAttribute('aria-hidden') !== 'true') node.setAttribute('aria-hidden', 'true')
    const meta = CATEGORY_META[spec.category]
    const cls = `gf-underline gf-underline--${meta.underlineStyle}`
    if (node.className !== cls) node.className = cls
    if (spec.rect.width <= 0 || spec.rect.height <= 0) {
        node.style.display = 'none'
        return
    }
    node.style.display = ''
    node.style.color = meta.underline
    // wavy can't read currentColor in a data-URI bg; bake the colour. Other
    // variants use CSS currentColor, so clear any stale baked bg when leaving wavy.
    node.style.backgroundImage =
        meta.underlineStyle === 'wavy' ? wavyBackgroundImage(meta.underline) : ''
    node.style.width = `${Math.max(spec.rect.width, 4)}px`
    node.style.height = `${meta.underlineWidth}px`
    node.style.left = `${spec.rect.left}px`
    node.style.top = `${spec.rect.bottom - meta.underlineWidth}px`
}

/**
 * Append one underline node per rect into `root`, styled per category. The
 * returned handle owns those nodes and is the only safe way to remove them
 * (calling `destroy()` does NOT remove the host). The nodes are visual only;
 * the orchestrator owns hover/click via field-level hit-testing.
 */
export function renderUnderlines(
    root: ShadowRoot,
    options: RenderUnderlinesOptions,
): UnderlineHandle {
    const { rects, category } = options
    const nodes: HTMLDivElement[] = []
    for (const rect of rects) {
        if (rect.width <= 0 || rect.height <= 0) continue
        const node = root.ownerDocument.createElement('div')
        styleUnderlineNode(node, { rect, category })
        root.appendChild(node)
        nodes.push(node)
    }
    return {
        nodes,
        destroy: () => {
            for (const n of nodes) n.remove()
        },
    }
}

export interface UnderlineLayer {
    /** Diff the flat spec list against the pooled nodes; update in place. */
    reconcile: (specs: readonly UnderlineSpec[]) => void
    /** Remove every pooled node. */
    destroy: () => void
}

/**
 * A reconciling underline layer: owns ONE flat pool of nodes and updates it in
 * place on each reconcile (grow/shrink + restyle/reposition) instead of the
 * destroy-and-recreate that flickered. Nodes are interchangeable: a node's
 * category/colour/position are set per reconcile, so the same DOM node survives
 * across checks when the count is stable (§2.5).
 */
export function createUnderlineLayer(root: ShadowRoot): UnderlineLayer {
    const pool: HTMLDivElement[] = []
    return {
        reconcile(specs) {
            while (pool.length > specs.length) pool.pop()!.remove()
            while (pool.length < specs.length) {
                const n = root.ownerDocument.createElement('div')
                root.appendChild(n)
                pool.push(n)
            }
            for (let i = 0; i < specs.length; i++) styleUnderlineNode(pool[i]!, specs[i]!)
        },
        destroy() {
            for (const n of pool) n.remove()
            pool.length = 0
        },
    }
}
