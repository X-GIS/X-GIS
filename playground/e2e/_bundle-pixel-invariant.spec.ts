// iter-275 — bundle vs direct render pixel-invariant gate.
//
// Renders the SAME scene twice:
//   1. Bundle path OFF (default) — direct renderTileKeys every frame.
//   2. Bundle path ON — bundle replay where cache hits.
//
// Pixel-diffs the canvases. Must be byte-identical (or within bit-
// noise threshold) for bundle path to be considered safe to re-enable.
//
// Sets globalThis.__XGIS_BUNDLE_ENABLE before navigation so first
// frame already uses the chosen mode.

import { test, expect } from '@playwright/test'
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PNG } from 'pngjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(__dirname, '__convert-fixtures/bright.json'), 'utf8')
const outDir = resolve(__dirname, '__bundle-invariant__')

interface Scene {
  id: string
  hash: string
  // Tolerable pixel-diff count above (255-channel max-delta > THRESHOLD).
  maxDiffPixels: number
}

// Tight threshold — bundle must reproduce direct path output near-
// exactly. Any drift here is a state-capture gap in the cache key.
const SCENES: Scene[] = [
  { id: 'tokyo-z14', hash: '#14/35.6585/139.7454', maxDiffPixels: 50 },
  { id: 'seoul-z14', hash: '#14/37.5665/126.978', maxDiffPixels: 50 },
  { id: 'world-z3',  hash: '#3/30/120',           maxDiffPixels: 50 },
]

async function capture(page: import('@playwright/test').Page, scene: Scene, bundleOn: boolean): Promise<Buffer> {
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.addInitScript((on: boolean) => {
    ;(window as unknown as { __XGIS_BUNDLE_ENABLE: boolean }).__XGIS_BUNDLE_ENABLE = on
    const xgis = sessionStorage.getItem('__xgisImportSource')  // preserve if set
    if (!xgis) {
      // No-op; outer pre-set handles fixture.
    }
  }, bundleOn)
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript((src: string) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'bundle-invariant')
  }, xgis)
  await page.goto(`/demo.html?id=__import${scene.hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(7_000)
  return await page.locator('canvas').first().screenshot({ type: 'png' })
}

function diffPixels(a: Buffer, b: Buffer, threshold: number): {
  width: number; height: number; aboveThreshold: number; maxDelta: number
} {
  const pa = PNG.sync.read(a)
  const pb = PNG.sync.read(b)
  if (pa.width !== pb.width || pa.height !== pb.height) {
    throw new Error(`size mismatch ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`)
  }
  const w = pa.width, h = pa.height
  let aboveThreshold = 0
  let maxDelta = 0
  for (let i = 0; i < pa.data.length; i += 4) {
    const dr = Math.abs(pa.data[i]! - pb.data[i]!)
    const dg = Math.abs(pa.data[i + 1]! - pb.data[i + 1]!)
    const db = Math.abs(pa.data[i + 2]! - pb.data[i + 2]!)
    const m = Math.max(dr, dg, db)
    if (m > maxDelta) maxDelta = m
    if (m > threshold) aboveThreshold++
  }
  return { width: w, height: h, aboveThreshold, maxDelta }
}

for (const scene of SCENES) {
  test(`bundle vs direct pixel-identical — ${scene.id}`, async ({ browser }) => {
    test.setTimeout(120_000)
    mkdirSync(outDir, { recursive: true })

    // Two completely fresh contexts so storage / WebGPU adapter init
    // don't leak between runs.
    const ctxOff = await browser.newContext()
    const pageOff = await ctxOff.newPage()
    const off = await capture(pageOff, scene, false)
    await ctxOff.close()

    const ctxOn = await browser.newContext()
    const pageOn = await ctxOn.newPage()
    const on = await capture(pageOn, scene, true)
    await ctxOn.close()

    writeFileSync(resolve(outDir, `${scene.id}-off.png`), off)
    writeFileSync(resolve(outDir, `${scene.id}-on.png`), on)

    const r = diffPixels(off, on, 16 /* per-channel delta */)
    // eslint-disable-next-line no-console
    console.log(`[bundle-invariant ${scene.id}] ${r.width}×${r.height} maxDelta=${r.maxDelta} aboveThreshold=${r.aboveThreshold} (allowed ${scene.maxDiffPixels})`)
    expect(r.aboveThreshold).toBeLessThanOrEqual(scene.maxDiffPixels)
  })
}
