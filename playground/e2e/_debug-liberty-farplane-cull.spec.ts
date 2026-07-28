// Before/after capture for the #1427 far-plane cull.
//
// The cull's whole claim is that it is VISUALLY INERT — every tile it drops
// lies beyond the camera's own far plane, so the GPU was already discarding
// those fragments. That claim has to be measured, not argued: this spec
// screenshots the X-GIS canvas at the reported OFM Liberty camera (plus the
// pitches either side of the old pitch-60 cliff) into a tagged directory, so
// the same run can be repeated with the fix stashed and the two sets diffed.
//
// Run twice on the SAME code first — the noise floor from async tile-load
// timing is what any before-vs-after number has to beat.
//
//   CAP_TAG=after  bunx playwright test e2e/_debug-liberty-farplane-cull.spec.ts
//   CAP_TAG=after2 bunx playwright test e2e/_debug-liberty-farplane-cull.spec.ts
//   git stash && CAP_TAG=before bunx playwright test ... && git stash pop
//   bun scripts/diff-captures.ts <a> <b>

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { installOfflineProxy } from './helpers/offline-proxy'

const HERE = dirname(fileURLToPath(import.meta.url))
const TAG = process.env.CAP_TAG ?? 'run'
const OUT = join(HERE, '__debug-liberty-farplane__', TAG)
mkdirSync(OUT, { recursive: true })

const STYLE = process.env.CAP_STYLE ?? 'openfreemap-liberty'
const BASE = process.env.CAP_BASE ?? '16.00/51.50466/-0.11813/60.0'
const PITCHES = (process.env.CAP_PITCHES ?? '59,60,72.4').split(',')
/** Settle window. 30 s converges pitch 59 and 72.4 to byte-identical frames
 *  across runs; pitch 60 needs longer — its building tiles are bistable at
 *  30 s (two same-code runs differed by 23 % there, one with 3D buildings
 *  drawn and one without), which swamps any signal. */
const SETTLE_MS = Number(process.env.CAP_SETTLE_MS ?? 30_000)

for (const pitch of PITCHES) {
  test(`liberty far-plane capture p${pitch} [${TAG}]`, async ({ page }) => {
    test.setTimeout(300_000)
    const warnings: string[] = []
    page.on('console', (m) => {
      const t = m.text()
      if (/FLICKER|arena-oom/i.test(t)) warnings.push(t.slice(0, 200))
    })
    await installOfflineProxy(page, { cacheDir: join(HERE, '__net-cache__') })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/compare.html?style=${STYLE}#${BASE}/${pitch}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
        return w.__xgisReady === true && w.__mlReady === true
      },
      null,
      { timeout: 150_000 },
    )
    // Long settle so the frame is CONVERGED, not caught mid-load — an
    // unconverged frame would make the before/after diff measure tile-load
    // timing instead of the cull.
    await page.waitForTimeout(SETTLE_MS)
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    )

    const diag = await page.evaluate(() => {
      interface M {
        getStats?: () => { tilesVisible: number; drawCalls: number }
        getTileLoadDiagnostic: () => Record<string, Record<string, number>>
      }
      const m = (window as unknown as { __xgisMap: M }).__xgisMap
      return { stats: m.getStats?.(), diag: m.getTileLoadDiagnostic() }
    })

    const png = await page.locator('#xg-canv').screenshot()
    writeFileSync(join(OUT, `p${pitch}.png`), png)
    // MapLibre's pane too — the far-plane bound is a PARITY change, so the
    // directional diff (X-GIS vs ML, before and after) is the gate, not just
    // the before/after self-diff.
    const mlPng = await page.locator('#ml-map canvas').first().screenshot()
    writeFileSync(join(OUT, `ml-p${pitch}.png`), mlPng)
    writeFileSync(
      join(OUT, `p${pitch}.json`),
      JSON.stringify({ pitch, ...diag, flickerWarnings: warnings.length }, null, 2),
    )
    console.warn(`[cap ${TAG} p${pitch}]`, JSON.stringify({ ...diag, warn: warnings.length }))
    expect(PNG.sync.read(png).width).toBeGreaterThan(0)
  })
}
