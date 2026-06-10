// Discord-composer gate. Class names are hashed and churn between Discord
// builds, so match on the STEM via [class*=...] semantics — the stems
// ("channelTextArea") have been stable for years (research 2026-06-10).
// If Discord renames the stem the plugin degrades to "no fields attached"
// (silent, non-crashing); update the stem list here.
const COMPOSER_WRAPPER_STEMS = ['channelTextArea']

export function isDiscordComposer(el: HTMLElement): boolean {
    if (el.getAttribute('role') !== 'textbox') return false
    if (!el.isContentEditable && el.getAttribute('contenteditable') !== 'true') return false
    let node: HTMLElement | null = el
    while (node) {
        const cls = node.className
        if (
            typeof cls === 'string' &&
            COMPOSER_WRAPPER_STEMS.some((stem) => cls.includes(stem))
        ) {
            return true
        }
        node = node.parentElement
    }
    return false
}
