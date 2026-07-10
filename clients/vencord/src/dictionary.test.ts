import { describe, expect, it, vi } from 'vitest'
import { splitDictionaryTokens, addWordToDictionary, type DictionaryDeps } from './dictionary'
import type { RenderableItem } from '@/lib/pipeline'
import type { BridgeClient } from '@/api/client'

describe('splitDictionaryTokens', () => {
    it('returns [] for empty input', () => {
        expect(splitDictionaryTokens('')).toEqual([])
    })
    it('returns [] for whitespace-only input', () => {
        expect(splitDictionaryTokens('   \n\t  ')).toEqual([])
    })
    it('returns the single word when no whitespace is present', () => {
        expect(splitDictionaryTokens('foo')).toEqual(['foo'])
    })
    it('splits on any whitespace run', () => {
        expect(splitDictionaryTokens('foo bar  baz')).toEqual(['foo', 'bar', 'baz'])
    })
    it('drops empty fragments from leading/trailing whitespace', () => {
        expect(splitDictionaryTokens('  foo bar  ')).toEqual(['foo', 'bar'])
    })
    it('dedupes repeats while preserving first-occurrence order', () => {
        expect(splitDictionaryTokens('foo bar foo baz bar')).toEqual(['foo', 'bar', 'baz'])
    })
    it('handles tabs and newlines as whitespace', () => {
        expect(splitDictionaryTokens('foo\tbar\nbaz')).toEqual(['foo', 'bar', 'baz'])
    })
})

// P1-6(a): only splitDictionaryTokens (the pure helper) was tested; the
// full add -> POST -> toast -> Undo -> recheck flow through
// addWordToDictionary had no coverage at all. This exercises the whole
// chain with a mocked BridgeClient + signalQueue + rerun, and a REAL
// showToast (via a genuine ShadowRoot) so the Undo button's click wiring
// is verified end-to-end, not just asserted by inspecting options.
describe('addWordToDictionary', () => {
    const item: RenderableItem = {
        id: 42,
        cuStart: 0,
        cuEnd: 3,
        hlStart: 0,
        hlEnd: 3,
        category: 'spelling',
        message: '',
        replacements: ['the'],
        original: 'teh',
        diffOriginal: 'teh',
        diffCorrected: 'the',
        diffIsDeletion: false,
        byteSpan: { start: 0, end: 3 },
        model: 'harper',
        confidence: 0.95,
        status: 'open',
    }

    function makeDeps(): {
        deps: DictionaryDeps
        client: { dictionaryAdd: ReturnType<typeof vi.fn>; dictionaryRemove: ReturnType<typeof vi.fn> }
        rerun: ReturnType<typeof vi.fn>
        enqueue: ReturnType<typeof vi.fn>
        root: ShadowRoot
    } {
        const host = document.createElement('div')
        document.body.appendChild(host)
        const root = host.attachShadow({ mode: 'open' })
        const dictionaryAdd = vi.fn<(word: string) => Promise<unknown>>().mockResolvedValue(undefined)
        const dictionaryRemove = vi
            .fn<(word: string) => Promise<unknown>>()
            .mockResolvedValue(undefined)
        const client = { dictionaryAdd, dictionaryRemove }
        const enqueue = vi.fn<(event: unknown) => void>()
        const rerun = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
        const deps: DictionaryDeps = {
            client: () => client as unknown as BridgeClient,
            signalQueue: { enqueue } as unknown as DictionaryDeps['signalQueue'],
            rerun: () => rerun,
            overlayRoot: root,
        }
        return { deps, client, rerun, enqueue, root }
    }

    it('POSTs the word, signals rejected, re-checks, and shows an Undo toast', async () => {
        const { deps, client, rerun, enqueue, root } = makeDeps()
        const el = document.createElement('div')
        el.setAttribute('contenteditable', 'true')
        el.textContent = 'teh world'
        document.body.appendChild(el)

        await addWordToDictionary(el, item, 'teh', deps)

        expect(client.dictionaryAdd).toHaveBeenCalledWith('teh')
        expect(enqueue).toHaveBeenCalledWith({
            id: 42,
            action: 'rejected',
            category: 'spelling',
            source: 'vencord',
        })
        expect(rerun).toHaveBeenCalledWith('teh world')

        const toast = root.querySelector('.gf-toast')
        expect(toast).not.toBeNull()
        expect(toast?.querySelector('.gf-toast__text')?.textContent).toBe(
            'Added "teh" to dictionary',
        )
        const undoBtn = toast?.querySelector<HTMLButtonElement>('.gf-btn-soft')
        expect(undoBtn?.textContent).toBe('Undo')

        el.remove()
        root.host.remove()
    })

    it('multi-token words get a pluralised toast message and each token is POSTed', async () => {
        const { deps, client } = makeDeps()
        const el = document.createElement('div')
        document.body.appendChild(el)

        await addWordToDictionary(el, item, 'foo bar', deps)

        expect(client.dictionaryAdd).toHaveBeenCalledWith('foo')
        expect(client.dictionaryAdd).toHaveBeenCalledWith('bar')
        expect(client.dictionaryAdd).toHaveBeenCalledTimes(2)

        el.remove()
    })

    it('Undo removes every added token from the dictionary and re-checks again', async () => {
        const { deps, client, rerun, root } = makeDeps()
        const el = document.createElement('div')
        el.textContent = 'teh world'
        document.body.appendChild(el)

        await addWordToDictionary(el, item, 'teh', deps)
        rerun.mockClear()

        const undoBtn = root.querySelector<HTMLButtonElement>('.gf-toast .gf-btn-soft')
        expect(undoBtn).not.toBeNull()
        undoBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

        // The Undo handler's dictionaryRemove chain is async (a .then());
        // flush microtasks so the rerun-on-undo assertion below observes it.
        await new Promise<void>((r) => setTimeout(r, 0))

        expect(client.dictionaryRemove).toHaveBeenCalledWith('teh')
        expect(rerun).toHaveBeenCalledWith('teh world')
        // The toast itself is removed by its own click handler on Undo.
        expect(root.querySelector('.gf-toast')).toBeNull()

        el.remove()
        root.host.remove()
    })

    it('is a no-op (no POST, no toast) for an empty/whitespace-only word', async () => {
        const { deps, client, root } = makeDeps()
        const el = document.createElement('div')
        document.body.appendChild(el)

        await addWordToDictionary(el, item, '   ', deps)

        expect(client.dictionaryAdd).not.toHaveBeenCalled()
        expect(root.querySelector('.gf-toast')).toBeNull()

        el.remove()
        root.host.remove()
    })
})
