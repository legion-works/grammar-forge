// "Add to dictionary" flow for the Vencord pill panel. Splits the
// user-supplied word into tokens, dedupes, calls the bridge's
// dictionaryAdd endpoint, logs a rejected signal, re-checks, shows a
// toast with an Undo affordance. Pure token-split is exported for
// tests; the rest is a closure over the orchestrator's deps.

import type { RenderableItem } from '@/lib/pipeline'
import { getText } from '@/input/text'
import type { BridgeClient } from '@/api/client'
import type { SignalQueue } from '@/signal/queue'
import { showToast } from '@/overlay/toast'
import { debugLog } from './debug-log'

/** Pure: split a word into non-empty whitespace-separated tokens, deduped,
 *  preserve order. Returns [] for empty/whitespace input. */
export function splitDictionaryTokens(word: string): string[] {
    return [...new Set(word.split(/\s+/).filter((t) => t.length > 0))]
}

export interface DictionaryDeps {
    client: () => BridgeClient
    signalQueue: SignalQueue
    rerun: (el: HTMLElement) => (text: string) => Promise<void>
    overlayRoot: ShadowRoot
}

export function addWordToDictionary(
    el: HTMLElement,
    item: RenderableItem,
    word: string,
    deps: DictionaryDeps,
): Promise<void> {
    const tokens = splitDictionaryTokens(word)
    if (tokens.length === 0) return Promise.resolve()
    const c = deps.client()
    return Promise.all(tokens.map((t) => c.dictionaryAdd(t)))
        .then(() => {
            deps.signalQueue.enqueue({
                id: item.id,
                action: 'rejected',
                category: item.category,
                source: 'vencord',
            })
            debugLog('dictionary add', 'dictionary add', { tokens, itemId: item.id })
            void deps.rerun(el)(getText(el))
            const label =
                tokens.length === 1
                    ? `Added "${tokens[0]}" to dictionary`
                    : `Added ${tokens.length} words to dictionary`
            showToast(deps.overlayRoot, {
                message: label,
                actionLabel: 'Undo',
                onAction: () => {
                    Promise.all(tokens.map((t) => c.dictionaryRemove(t)))
                        .then(() => deps.rerun(el)(getText(el)))
                        .catch((e) => debugLog('dictionary undo remove failed', e))
                },
            })
        })
        .catch((e) => {
            debugLog('dictionary add failed', e)
        })
}
