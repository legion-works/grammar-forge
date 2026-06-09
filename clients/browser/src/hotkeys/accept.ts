/**
 * Pure decision logic for the in-content "accept suggestion" hotkey.
 *
 * Default `Ctrl+.` is captured by a `keydown` listener in the content script
 * (not the `commands` API — the manifest API can't reliably bind `Ctrl+.`
 * cross-OS). The hotkey must ONLY fire when a popover/span is active; when no
 * suggestion is open the chord must pass through so Tab, normal typing, and
 * other key combos keep working.
 */

/** A subset of `KeyboardEvent` we actually read — keeps the matcher pure. */
export interface HotkeyEvent {
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    metaKey: boolean
    key: string
}

export interface ParsedHotkey {
    ctrl: boolean
    shift: boolean
    alt: boolean
    meta: boolean
    key: string
}

const MODIFIER_KEYS = new Set([
    'Control',
    'Ctrl',
    'Shift',
    'Alt',
    'Option',
    'Meta',
    'Cmd',
    'Command',
])

/**
 * Parse a hotkey string like `"Ctrl+."`, `"Cmd+."`, `"Ctrl+Shift+Period"` into
 * a structured representation. Modifier spellings are normalised:
 *   Ctrl/Control → ctrl, Cmd/Command/Meta → meta (with ctrl also set so
 *   `matchesHotkey` is cross-OS), Alt/Option → alt, Shift → shift. Keys are
 *   kept verbatim for `matchesHotkey` to compare case-insensitively.
 *
 * Throws on an empty string or a bare key (no modifier), since a chord-less
 * binding would hijack typing.
 */
export function parseHotkey(input: string): ParsedHotkey {
    const parts = input
        .split('+')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
    if (parts.length === 0) throw new Error('empty hotkey string')

    let ctrl = false
    let shift = false
    let alt = false
    let meta = false
    let key: string | null = null

    for (const raw of parts) {
        const part = raw.toLowerCase()
        switch (part) {
            case 'ctrl':
            case 'control':
                ctrl = true
                break
            case 'shift':
                shift = true
                break
            case 'alt':
            case 'option':
                alt = true
                break
            case 'cmd':
            case 'command':
            case 'meta':
                meta = true
                ctrl = true // Cmd is the macOS Ctrl — match against either
                break
            default:
                if (MODIFIER_KEYS.has(raw)) break
                if (key !== null) throw new Error(`hotkey has multiple keys: ${input}`)
                // Normalise the key to lowercase so storage and comparison are
                // case-stable (browsers report `key` as "z" or "Z" etc).
                key = raw.toLowerCase()
        }
    }

    if (key === null) throw new Error(`hotkey must include a non-modifier key: ${input}`)
    if (!ctrl && !shift && !alt && !meta) {
        throw new Error(`hotkey must include at least one modifier: ${input}`)
    }

    return { ctrl, shift, alt, meta, key }
}

/**
 * Return true iff `event` matches the parsed chord. `Ctrl` on Windows/Linux
 * and `Cmd` (metaKey) on macOS both satisfy a parsed `ctrl` flag, so the same
 * `Ctrl+.` config works on both OSes. Comparison on the key is
 * case-insensitive — browsers report `key` as `"."` or `"Period"` etc.
 */
export function matchesHotkey(event: HotkeyEvent, parsed: ParsedHotkey): boolean {
    if (parsed.ctrl && !(event.ctrlKey || event.metaKey)) return false
    if (parsed.shift && !event.shiftKey) return false
    if (parsed.alt && !event.altKey) return false
    if (parsed.meta && !event.metaKey) return false
    return event.key.toLowerCase() === parsed.key.toLowerCase()
}

export interface ShouldAcceptOptions {
    hotkey: string
    hasActiveSuggestion: boolean
}

/**
 * Decide whether `event` should trigger the accept action. Returns true ONLY
 * when (a) the chord matches the configured hotkey AND (b) a popover/span is
 * active. When no suggestion is open the hotkey returns false so the browser
 * keeps its default behaviour (Tab, typing, etc. are not hijacked).
 */
export function shouldAcceptHotkey(event: HotkeyEvent, opts: ShouldAcceptOptions): boolean {
    if (!opts.hasActiveSuggestion) return false
    return matchesHotkey(event, parseHotkey(opts.hotkey))
}
