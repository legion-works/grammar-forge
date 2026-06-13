// Minimal structural mirror of the patched OpenCode TUI plugin API surface
// the GrammarForge plugin consumes. Source of truth:
// packages/plugin/src/tui.ts on the feat/tui-prompt-facade branch.

export interface PromptPartSourceText {
    start: number;
    end: number;
    value: string;
}

export interface PromptPart {
    type: string;
    // Mirrors the real TuiPromptInfo part union (packages/plugin/src/tui.ts):
    //   - TextPart (extended): source?.text?.{start,end,value}
    //   - AgentPart:           source?.{start,end,value}     (no .text nesting)
    //   - FilePart:            source?.text?.{start,end,value}
    //     (plus type/path/range/... — ignored, we only need the text range)
    source?: {
        start?: number;
        end?: number;
        value?: string;
        text?: PromptPartSourceText;
    };
}

export interface PromptInfo {
    input: string;
    parts: PromptPart[];
}

export interface PromptExtmarks {
    registerType(typeName: string): number;
    create(options: {
        start: number;
        end: number;
        virtual?: boolean;
        styleId?: number;
        priority?: number;
        typeId?: number;
    }): number;
    getAllForTypeId(typeId: number): Array<{ id: number; start: number; end: number }>;
    delete(id: number): boolean;
}

export interface PromptRef {
    readonly text: string;
    readonly current: PromptInfo;
    /**
     * Cursor offset in DISPLAY-WIDTH code units (terminal cells), mirroring
     * the real PromptRef.cursorOffset (packages/tui/src/component/prompt).
     * Optional: unpatched/older builds lack it; feature-detect.
     */
    readonly cursorOffset?: number;
    /**
     * Move the cursor to a display-width offset (same model as cursorOffset).
     * Optional: unpatched builds lack it; feature-detect before calling.
     */
    setCursorOffset?(offset: number): void;
    /**
     * Convert a display-width offset (same model as cursorOffset) to
     * absolute screen coordinates {x, y}. Returns null when the prompt
     * is unmounted, the offset is out of range, or the textarea has not
     * been laid out yet. Optional: unpatched builds lack it.
     */
    offsetToScreen?(offset: number): { x: number; y: number } | null;
    getTextRange(startOffset: number, endOffset: number): string;
    replaceRange(startOffset: number, endOffset: number, replacement: string): void;
    readonly extmarks: PromptExtmarks;
    focus(): void;
}

export interface PromptApi {
    ref(): PromptRef | undefined;
    onChange(callback: () => void): () => void;
    /**
     * Fires on every cursor mutation (arrows, click, drag, word-moves, paste,
     * undo/redo). Mirrors the real TuiPromptApi.onCursorChange
     * (packages/plugin/src/tui.ts). Optional: unpatched builds lack it.
     */
    onCursorChange?(callback: () => void): () => void;
}

export interface SyntaxStyleApi {
    registerStyle(
        name: string,
        style: {
            fg?: string;
            bg?: string;
            underline?: boolean;
            bold?: boolean;
            italic?: boolean;
            dim?: boolean;
        },
    ): number;
    getStyleId(name: string): number | null;
}

export interface KeymapLayer {
    priority?: number;
    /**
     * Optional getter: when present, the host keymap only dispatches
     * this layer's bindings while `enabled()` returns true. The host
     * Keymap type is `Keymap<Renderable, KeyEvent>` from
     * `@opentui/keymap` (re-exported in `packages/plugin/src/tui.ts:79`),
     * and supports `enabled` on layers. Mirrored here as an optional
     * callback to match the real contract.
     */
    enabled?: () => boolean;
    commands?: Array<{ name: string; title?: string; run: () => unknown }>;
    bindings?: Array<{ key: string; cmd: string }>;
}

/**
 * Slot plugin contract — mirrors the real TuiSlotPlugin
 * (packages/plugin/src/tui.ts:556-558 = Omit<SolidPlugin<TuiSlotMap,
 * TuiSlotContext>, "id">). The render functions return JSX.Element. We
 * don't depend on a JSX runtime in this plugin; the orchestrator builds
 * the panel via opentui's `createComponent(text, { content })` shape and
 * returns the result, which is the smallest valid non-JSX JSX.Element.
 * Slot names targeted: `home_prompt_right` (no props) and
 * `session_prompt_right` ({ session_id: string }).
 */
export interface SlotPluginRenderContext {
    theme: Record<string, unknown>;
}

export interface TuiSlotsApi {
    register(plugin: {
        slots: {
            // Both slots accept the widest possible context shape; the host
            // passes TuiSlotContext (theme) plus any host-slot-specific
            // props (e.g. session_id for session_prompt_right). The plugin
            // doesn't read those props — it renders the panel from its
            // own closure state — so we use a permissive ctx type.
            home_prompt_right?: (ctx: SlotPluginRenderContext) => unknown;
            session_prompt_right?: (ctx: SlotPluginRenderContext) => unknown;
            // Other host slots exist; the orchestrator only registers the
            // two above. Add the rest here if a future task needs them.
            [slotName: string]: ((ctx: SlotPluginRenderContext) => unknown) | undefined;
        };
    }): string;
}

export interface TuiApi {
    prompt?: PromptApi; // optional: unpatched builds lack it — plugin must no-op
    keymap: { registerLayer(layer: KeymapLayer): () => void };
    ui: { toast(input: { message: string; variant?: string }): void };
    theme: { syntax?(): SyntaxStyleApi } & Record<string, unknown>;
    lifecycle: { onDispose(fn: () => void): () => void };
    /**
     * Optional: the real TuiPluginApi.slots is always present on a patched
     * build, but we feature-detect anyway — consistent with `prompt?` above.
     * Returns a host-assigned slot id (no disposer; lifecycle owns teardown).
     */
    slots?: TuiSlotsApi;
}

export type TuiPlugin = (
    api: TuiApi,
    options: Record<string, unknown> | undefined,
    meta: unknown,
) => Promise<void>;

export interface TuiPluginModule {
    id?: string;
    tui: TuiPlugin;
    server?: never;
}
