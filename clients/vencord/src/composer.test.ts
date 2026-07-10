import { describe, expect, it } from 'vitest'
import { isDiscordComposer } from './composer'

function el(html: string): HTMLElement {
    document.body.innerHTML = html
    return document.body.querySelector<HTMLElement>('[data-test]')!
}

describe('isDiscordComposer', () => {
    it('accepts the channel composer (role=textbox inside channelTextArea wrapper)', () => {
        const t = el(
            '<div class="channelTextArea_abc123"><div data-test role="textbox" contenteditable="true"></div></div>',
        )
        expect(isDiscordComposer(t)).toBe(true)
    })
    it('accepts the inline message-edit composer', () => {
        const t = el(
            '<div class="channelTextArea_x messageEditArea_y"><div data-test role="textbox" contenteditable="true"></div></div>',
        )
        expect(isDiscordComposer(t)).toBe(true)
    })
    it('rejects the search box (no channelTextArea ancestor)', () => {
        const t = el(
            '<div class="searchBar_q"><div data-test role="textbox" contenteditable="true"></div></div>',
        )
        expect(isDiscordComposer(t)).toBe(false)
    })
    it('rejects non-editable textboxes', () => {
        const t = el('<div class="channelTextArea_abc"><div data-test role="textbox"></div></div>')
        expect(isDiscordComposer(t)).toBe(false)
    })
})

// P1-5: INSTRUCTIONS.md §D requires the plugin to attach to every Discord
// composer surface, not just the top-level channel composer. Discord
// implements threads AND forum posts as channels in its data model (a
// thread/forum-post is a child channel, not a distinct message-input
// component), so the assumption verified here — carried over from live
// research 2026-06-10 that named "channelTextArea" as the stable stem — is
// that Discord renders the SAME ChannelTextArea/SlateTextArea component
// tree (hence the same "channelTextArea" class stem) for:
//   - the main channel composer (covered above),
//   - a thread's reply composer (same component, scoped to the thread
//     channel),
//   - a forum post's message body editor (the post-creation flow adds a
//     separate title field alongside this same editor component), and
//   - the inline message-edit composer (covered above via
//     "messageEditArea" alongside "channelTextArea").
// If a future Discord build introduces a genuinely distinct stem for one
// of these surfaces, isDiscordComposer's COMPOSER_WRAPPER_STEMS list
// should be extended (conservatively — an over-broad match risks
// attaching to non-composer textboxes) and this fixture's assumed stem
// updated to match, with a note of which Discord build was observed.
describe('isDiscordComposer — composer variants (P1-5)', () => {
    it('accepts a thread reply composer', () => {
        const t = el(
            '<div class="channelTextArea_thread987"><div data-test role="textbox" contenteditable="true"></div></div>',
        )
        expect(isDiscordComposer(t)).toBe(true)
    })
    it('accepts a forum post composer (new-post message body editor)', () => {
        const t = el(
            '<div class="channelTextArea_forumPost456"><div data-test role="textbox" contenteditable="true"></div></div>',
        )
        expect(isDiscordComposer(t)).toBe(true)
    })
    it('accepts a deeply-nested composer (wrapper several ancestors up, mirrors real Discord DOM depth)', () => {
        const t = el(
            '<div class="channelTextArea_deep"><div class="inner"><div class="scrollableContainer"><div data-test role="textbox" contenteditable="true"></div></div></div></div>',
        )
        expect(isDiscordComposer(t)).toBe(true)
    })
})
