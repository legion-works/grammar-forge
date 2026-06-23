// Bridge wire contract types. The bridge returns UTF-8 byte offsets for
// suggestion spans; the DOM is UTF-16 code units. Conversion + verification
// lives in @/api/offset.

export type Category = 'spelling' | 'grammar' | 'punctuation' | 'style' | 'typography' | 'unknown'

/** Lifecycle status of a renderable item (drives the underline visibility and
 *  the bulk-action skip-list in the panel). Defaults to `'open'` on the wire. */
export type ItemStatus = 'open' | 'accepted' | 'dismissed'

export interface ByteSpan {
    start: number
    end: number
}

export interface BridgeSuggestion {
    id?: number
    span: ByteSpan
    replacement: string
    replacements?: string[]
    message?: string
    model: 'harper' | 'gector' | 'llm' | 'lt_rule'
    ruleId?: string
    confidence?: number
    category?: string
}

export interface CorrectResponse {
    original: string
    suggestions: BridgeSuggestion[]
    score: number
}

export interface CorrectRequest {
    text: string
    picky?: boolean
    source: string
}

export interface RephraseOverride {
    provider: 'openai' | 'anthropic'
    baseUrl: string
    model: string
    apiKey: string
}

export interface RephraseRequest {
    text: string
    tone?: string
    style?: string
    alternatives?: number
    source: string
    override?: RephraseOverride
}

export interface RephraseResponse {
    original: string
    rephrased: string
    alternatives: string[]
}

export interface CompleteRequest {
    text: string
    /** Max tokens for the continuation. Default on the bridge side: 64. */
    max_tokens?: number
    temperature?: number
    source: string
}

export interface CompleteResponse {
    continuation: string
}

// ── Redesign response types (W2-foundation) ─────────────────────────────────

/** GET /stats — extended stats payload driving the panel score ring, streak
 *  card, and "top issues this week" bars. `top_issues` is always present (the
 *  bridge serialises an empty map as `{}`, never `null`); the count fields
 *  predate the redesign and remain unchanged. */
export interface StatsResponse {
    corrections: number
    edits_total: number
    edits_accepted: number
    edits_rejected: number
    edits_ignored: number
    acceptance_rate?: number
    top_issues: Record<string, number>
    streak: number
    words_this_week: number
}

/** Single tag from the bridge's tone model — label + a 0-1 score
 *  (the higher the score, the more strongly the tag applies). */
export interface ToneTag {
    tag: string
    score: number
}

/** Per-sentence tone payload — only present when the bridge is called with
 *  `granularity: 'sentence'`. `span` is a UTF-16 code-unit range into the
 *  original text (consistent with the rest of the client). */
export interface ToneSentence {
    span: { start: number; end: number }
    tags: ToneTag[]
}

/** POST /tone response — at minimum, a field-level tag list. */
export interface ToneResponse {
    tags: ToneTag[]
    sentences?: ToneSentence[]
}

/** GET /synonyms?word=X response. `synonyms` is always an array (empty when
 *  the word is unknown or synonyms are disabled server-side). */
export interface SynonymsResponse {
    word: string
    synonyms: string[]
}

// ── Shared redesign types (W2-foundation; consumed by W2 surfaces) ─────────

/** Writing goals — drive the visible-items filter (informal mutes style),
 *  the rephrase tone seed, and the panel's Goals popover. `domain` is a
 *  free-form string (e.g. "academic", "marketing") and may be omitted. */
export interface Goals {
    audience: 'general' | 'informed' | 'expert'
    formality: 'informal' | 'neutral' | 'formal'
    domain?: string
}

/** Streaming stage for the fast→slow pipeline. 'fast' is the local-rules
 *  preview (Harper + GECToR + cached LLM); 'done' includes the LLM
 *  escalation. LLM items are suppressed during 'fast'. */
export type Phase = 'fast' | 'done'

/** Score band label. Cut-offs: ≥90 excellent, ≥78 good, ≥60 fair, else
 *  needs-work (see flows.md §0). */
export type Band = 'excellent' | 'good' | 'fair' | 'needs-work'
