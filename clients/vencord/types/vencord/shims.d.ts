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
