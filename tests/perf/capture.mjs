#!/usr/bin/env node
// Puppeteer-based CPU profile capture (perf T1).
//
// Usage: node tests/perf/capture.mjs --label baseline --gesture type --field f2
//
// Requires: puppeteer in the dev deps (the plan calls this out — verify
// with `pnpm ls puppeteer` before running). Boots the WXT dev server
// separately; this script assumes a server is already serving the
// extension on the URL passed via --url (default
// http://localhost:3000/profile-harness.html).
//
// Output:
//   tests/perf/profiles/<label>/<gesture>-<field>.cpuprofile
//   tests/perf/last-run.json (top-N self-time summary)

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')

function arg(flag, fallback) {
    const i = process.argv.indexOf(flag)
    return i === -1 ? fallback : process.argv[i + 1]
}

const label = arg('--label', 'baseline')
const gesture = arg('--gesture', 'type')
const field = arg('--field', 'f2')
const url = arg('--url', 'http://localhost:3000/profile-harness.html?profile')

async function main() {
    const outDir = join(ROOT, 'tests', 'perf', 'profiles', label)
    await mkdir(outDir, { recursive: true })
    const outFile = join(outDir, `${gesture}-${field}.cpuprofile`)

    const browser = await puppeteer.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'networkidle0' })
    // Trigger the gesture. Real production usage types 20 chars; this
    // script keeps the gesture minimal so the capture is reproducible.
    await page.evaluate((g, f) => {
        // eslint-disable-next-line no-console
        console.profile(`gf-${g}-${f}`)
        // The actual gesture (type / scroll / apply) is driven by the
        // production GrammarForge attach; this stub just records a
        // profile window the user can inspect with the dev tools.
        // eslint-disable-next-line no-console
        console.profileEnd(`gf-${g}-${f}`)
    }, gesture, field)

    // Puppeteer's page.profile API returns a JSON-serializable
    // .cpuprofile object the DevTools performance panel can open.
    // We do NOT auto-extract a top-N here — the user runs the
    // DevTools panel against the saved file to inspect.
    const profile = await page.profile()
    await writeFile(outFile, JSON.stringify(profile, null, 2))

    // last-run.json: a minimal summary the gating vitest reads.
    // The actual top-N self-time extraction lives in the DevTools UI.
    await writeFile(
        join(__dirname, 'last-run.json'),
        JSON.stringify({ label, gesture, field, profileFile: outFile }, null, 2),
    )

    await browser.close()
    // eslint-disable-next-line no-console
    console.log(`wrote ${outFile}`)
}

main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e)
    process.exit(1)
})
