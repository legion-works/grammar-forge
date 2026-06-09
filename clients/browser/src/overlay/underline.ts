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
    const meta = CATEGORY_META[category]
    const nodes: HTMLDivElement[] = []
    for (const rect of rects) {
        if (rect.width <= 0 || rect.height <= 0) continue
        const node = root.ownerDocument.createElement('div')
        node.className = `gf-underline gf-underline--${meta.underlineStyle}`
        node.setAttribute('aria-hidden', 'true')
        node.style.color = meta.underline
        node.style.width = `${Math.max(rect.width, 4)}px`
        node.style.height = `${meta.underlineWidth}px`
        node.style.left = `${rect.left}px`
        node.style.top = `${rect.bottom - meta.underlineWidth}px`
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
