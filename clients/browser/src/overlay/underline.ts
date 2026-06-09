// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// Render the per-rect underline nodes inside a shadow root. One position:fixed
// node per getClientRects() rect (a wrapped line = two rects = two nodes).
// mousedown is preventDefault'd + stopPropagation'd so clicking an underline
// never steals focus from the field the user is typing into; click opens the
// popover via the injected callback.
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
    /** Fires when the user clicks an underline. The owning suggestion is
     *  passed back so the popover can show context. */
    onClick: (e: MouseEvent) => void
}

/**
 * Append one underline node per rect into `root`, styled per category. The
 * returned handle owns those nodes and is the only safe way to remove them
 * (calling `destroy()` does NOT remove the host).
 */
export function renderUnderlines(
    root: ShadowRoot,
    options: RenderUnderlinesOptions,
): UnderlineHandle {
    const { rects, category, onClick } = options
    const meta = CATEGORY_META[category]
    const nodes: HTMLDivElement[] = []
    for (const rect of rects) {
        if (rect.width <= 0 || rect.height <= 0) continue
        const node = root.ownerDocument.createElement('div')
        node.className = `gf-underline gf-underline--${meta.underlineStyle}`
        node.setAttribute('role', 'button')
        node.setAttribute('tabindex', '0')
        node.setAttribute('aria-label', `${meta.label} suggestion`)
        node.style.color = meta.underline
        node.style.width = `${Math.max(rect.width, 4)}px`
        node.style.height = `${meta.underlineWidth}px`
        node.style.left = `${rect.left}px`
        node.style.top = `${rect.bottom - meta.underlineWidth}px`
        // mousedown: don't steal focus from the field
        node.addEventListener('mousedown', (event) => {
            event.preventDefault()
            event.stopPropagation()
        })
        // click: open the popover
        node.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            onClick(event)
        })
        // keyboard: Enter / Space = click
        node.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                event.stopPropagation()
                // synthesise a MouseEvent-like value the consumer can ignore;
                // real coordinates are irrelevant at this layer.
                onClick(event as unknown as MouseEvent)
            }
        })
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
