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
// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
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
}

const SCENES: Scene[] = [
  { id: 'tokyo-z14', hash: '#14/35.6585/139.7454' },
  { id: 'seoul-z14', hash: '#14/37.5665/126.978' },
  { id: 'world-z3', hash: '#3/30/120' },
]

// Bundle delta must not exceed direct-vs-direct noise baseline by more
// than this multiplier. WebGPU rendering is not bit-deterministic at
// dense z14 scenes (FP ordering in shaders + atomic write ordering),
// so the per-channel pixel diff between two consecutive direct-render
// captures is itself non-zero. Bundle replay is considered safe iff
// its delta is within noise band.
const BUNDLE_NOISE_FACTOR = 1.5

async function capture(
  page: import('@playwright/test').Page,
  scene: Scene,
  bundleOn: boolean,
): Promise<Buffer> {
  await page.setViewportSize({ width: 1024, height: 768 })
  // iter-276 — bundle default ON. Disable via __XGIS_BUNDLE_DISABLE.
  await page.addInitScript((on: boolean) => {
    ;(window as unknown as { __XGIS_BUNDLE_DISABLE: boolean }).__XGIS_BUNDLE_DISABLE = !on
  }, bundleOn)
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript((src: string) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'bundle-invariant')
  }, xgis)
  await page.goto(`/demo.html?id=__import${scene.hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(7_000)
  return await page.locator('canvas').first().screenshot({ type: 'png' })
}

function diffPixels(
  a: Buffer,
  b: Buffer,
  threshold: number,
  outPath?: string,
): {
  width: number
  height: number
  aboveThreshold: number
  maxDelta: number
} {
  const pa = PNG.sync.read(a)
  const pb = PNG.sync.read(b)
  if (pa.width !== pb.width || pa.height !== pb.height) {
    throw new Error(`size mismatch ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`)
  }
  const w = pa.width,
    h = pa.height
  let aboveThreshold = 0
  let maxDelta = 0
  const diff = outPath ? new PNG({ width: w, height: h }) : null
  for (let i = 0; i < pa.data.length; i += 4) {
    const dr = Math.abs(pa.data[i]! - pb.data[i]!)
    const dg = Math.abs(pa.data[i + 1]! - pb.data[i + 1]!)
    const db = Math.abs(pa.data[i + 2]! - pb.data[i + 2]!)
    const m = Math.max(dr, dg, db)
    if (m > maxDelta) maxDelta = m
    if (m > threshold) aboveThreshold++
    if (diff) {
      // Red = bundle-on differs. Scale delta×3 for visibility.
      diff.data[i] = Math.min(255, m * 3)
      diff.data[i + 1] = 0
      diff.data[i + 2] = 0
      diff.data[i + 3] = 255
    }
  }
  if (diff && outPath) writeFileSync(outPath, PNG.sync.write(diff))
  return { width: w, height: h, aboveThreshold, maxDelta }
}

for (const scene of SCENES) {
  test(`bundle vs direct pixel-identical — ${scene.id}`, async ({ browser }) => {
    test.setTimeout(120_000)
    mkdirSync(outDir, { recursive: true })

    // Three captures: off, off2 (sanity for non-determinism), on.
    const ctxOff = await browser.newContext()
    const off = await capture(await ctxOff.newPage(), scene, false)
    await ctxOff.close()

    const ctxOff2 = await browser.newContext()
    const off2 = await capture(await ctxOff2.newPage(), scene, false)
    await ctxOff2.close()

    const ctxOn = await browser.newContext()
    const on = await capture(await ctxOn.newPage(), scene, true)
    await ctxOn.close()

    writeFileSync(resolve(outDir, `${scene.id}-off.png`), off)
    writeFileSync(resolve(outDir, `${scene.id}-off2.png`), off2)
    writeFileSync(resolve(outDir, `${scene.id}-on.png`), on)

    const noise = diffPixels(off, off2, 16, resolve(outDir, `${scene.id}-noise.png`))
    const r = diffPixels(off, on, 16, resolve(outDir, `${scene.id}-diff.png`))
    const limit = Math.max(50, Math.round(noise.aboveThreshold * BUNDLE_NOISE_FACTOR))

    console.log(
      `[bundle-invariant ${scene.id}] NOISE  off-vs-off2: maxDelta=${noise.maxDelta} aboveThreshold=${noise.aboveThreshold}`,
    )

    console.log(
      `[bundle-invariant ${scene.id}] BUNDLE off-vs-on:   maxDelta=${r.maxDelta} aboveThreshold=${r.aboveThreshold} (allowed=${limit} = max(50, noise×${BUNDLE_NOISE_FACTOR}))`,
    )
    expect(r.aboveThreshold).toBeLessThanOrEqual(limit)
  })
}
