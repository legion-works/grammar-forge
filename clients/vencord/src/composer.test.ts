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
