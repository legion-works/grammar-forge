// Minimal ambient types for the Vencord modules the plugin imports.
// We bundle with these EXTERNAL; Vencord supplies the real implementations
// at its own build time. Keep the surface tiny and update against the
// Vencord checkout if a signature drifts.

declare module '@utils/types' {
    export interface PluginDef {
        name: string
        description: string
        authors: { name: string; id: bigint }[]
        start?(): void
        stop?(): void
        settings?: unknown
        chatBarButton?: {
            render: (props: { isMainChat: boolean; isAnyChat: boolean }) => unknown
            icon: (props: {
                height?: number | string
                width?: number | string
                className?: string
            }) => unknown
        }
        [key: string]: unknown
    }
    export default function definePlugin<P extends PluginDef>(p: P): P
    export enum OptionType {
        STRING = 0,
        NUMBER = 1,
        BIGINT = 2,
        BOOLEAN = 3,
        SELECT = 4,
        SLIDER = 5,
        COMPONENT = 6,
        CUSTOM = 7,
    }
}

declare module '@api/Settings' {
    // Loosely typed on purpose: we only read `.store.<key>`.
    export function definePluginSettings<T extends Record<string, unknown>>(
        settings: T,
    ): { store: Record<string, any>; [key: string]: unknown }
}

declare module '@api/ChatButtons' {
    // ChatBarButton in Vencord wraps a Tooltip + Clickable pair; we only
    // pass tooltip, onClick, buttonProps (for aria attrs) + children. Real
    // signature lives in Vencord/src/api/ChatButtons.tsx (ChatBarButtonProps).
    type ClickEvent = { currentTarget: HTMLElement }
    export const ChatBarButton: (props: {
        tooltip: string
        onClick: (e: ClickEvent) => void
        onContextMenu?: (e: ClickEvent) => void
        onAuxClick?: (e: ClickEvent) => void
        buttonProps?: Record<string, unknown>
        children?: unknown
    }) => unknown
}

declare module '@webpack/common' {
    // Vencord re-exports React + a curated subset of @webpack/common
    // primitives. We only need the React surface (createElement + the
    // three hooks we use) — no other named exports are imported here.
    // Real bindings: Vencord/src/webpack/common.tsx.
    export const React: {
        createElement: (
            type: string | ((props: never) => unknown),
            props?: Record<string, unknown> | null,
            ...children: unknown[]
        ) => unknown
        useState: <S>(initial: S | (() => S)) => [S, (next: S | ((prev: S) => S)) => void]
        useEffect: (effect: () => void | (() => void), deps?: ReadonlyArray<unknown>) => void
        useRef: <T>(initial: T) => { current: T }
    }
}
