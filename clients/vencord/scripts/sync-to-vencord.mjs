// Copies the built plugin into the user's Vencord checkout.
// Usage: VENCORD_REPO=~/projects/Vencord pnpm sync
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const vencordRepo = (
  process.env.VENCORD_REPO ?? path.join(os.homedir(), 'projects/Vencord')
).replace(/^~(?=\/)/, os.homedir())
const src = path.join(here, '../dist/grammarForge')
const dest = path.join(vencordRepo, 'src/userplugins/grammarForge')

if (!existsSync(path.join(vencordRepo, 'src'))) {
  // oxlint-disable-next-line no-console
  console.error(`Vencord checkout not found at ${vencordRepo} (set VENCORD_REPO)`)
  process.exit(1)
}
if (!existsSync(src)) {
  // oxlint-disable-next-line no-console
  console.error('dist/grammarForge missing — run the build first')
  process.exit(1)
}
mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })
// oxlint-disable-next-line no-console
console.log(`Synced -> ${dest}`)
// oxlint-disable-next-line no-console
console.log('Now: cd', vencordRepo, '&& pnpm build && restart Discord')
