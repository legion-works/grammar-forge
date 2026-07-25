import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CONTENT_PATH = fileURLToPath(
    new URL('./src/entrypoints/content/index.ts', import.meta.url),
)
const source = readFileSync(CONTENT_PATH, 'utf8')

describe('content-script bridge transport wiring', () => {
    it.each(['s', 'next'])('injects the background transport when constructing the %s client', (name) => {
        expect(source).toMatch(
            new RegExp(
                `new BridgeClient\\(\\s*${name}\\.bridgeBaseUrl,\\s*${name}\\.allowRemoteBridge,\\s*createBackgroundBridgeFetch\\(${name}\\.bridgeBaseUrl\\),\\s*\\)`,
            ),
        )
    })
})
