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
    getTextRange(startOffset: number, endOffset: number): string;
    replaceRange(startOffset: number, endOffset: number, replacement: string): void;
    readonly extmarks: PromptExtmarks;
    focus(): void;
}

export interface PromptApi {
    ref(): PromptRef | undefined;
    onChange(callback: () => void): () => void;
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
    commands?: Array<{ name: string; title?: string; run: () => unknown }>;
    bindings?: Array<{ key: string; cmd: string }>;
}

export interface TuiApi {
    prompt?: PromptApi; // optional: unpatched builds lack it — plugin must no-op
    keymap: { registerLayer(layer: KeymapLayer): () => void };
    ui: { toast(input: { message: string; variant?: string }): void };
    theme: { syntax?(): SyntaxStyleApi } & Record<string, unknown>;
    lifecycle: { onDispose(fn: () => void): () => void };
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
