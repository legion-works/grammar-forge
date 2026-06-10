import { parseSSEStream } from '@/api/sse'
import { startOrchestrator } from './orchestrator'

// Placeholder entry — replaced by the real plugin in a later task.
// Importing a shared module proves the @ alias resolves at build time.
export default { name: 'GrammarForge', placeholder: true, parseSSEStream, startOrchestrator }
