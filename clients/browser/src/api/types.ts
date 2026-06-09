// Bridge wire contract types. The bridge returns UTF-8 byte offsets for
// suggestion spans; the DOM is UTF-16 code units. Conversion + verification
// lives in @/api/offset.

export type Category = 'spelling' | 'grammar' | 'punctuation' | 'style' | 'typography' | 'unknown'

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
