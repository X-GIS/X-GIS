// Projection coverage matrix — auto-detect projection issues across:
//   1. Zoom sweep:  8 proj × 6 zoom levels (incl. min-zoom edge)
//   2. Pitch sweep: 8 proj × 6 pitch values (0 → 75°)
//   3. Sudden switch: setProjection() sequence — verify post-switch frame
//      is sane (no NaN matrix, no 0-paint when it should render, no GPU
//      state corruption accumulating across switches).
//
// Page-reuse design: per projection (zoom/pitch) one test opens the demo
// page ONCE, then loops through state changes via location.hash mutation
// (demo-runner's hash-sync re-applies camera). Skips ~5-8s per cell of
// WebGPU adapter init + shader compile + tile fetch — ~10× faster than
// the per-cell page.goto baseline on SwiftShader. setProjection switch
// group runs all switches from a single mounted page sequentially, which
// also exercises "no resource leak across N switches" — stricter than
// the per-pair isolated baseline.
//
// Per cell captured: paint ratio, console errors, camera state, tile
// stats. Failures are collected within a sweep then asserted at the end
// so one bad cell doesn't mask the rest of the matrix. The assertions
// catch the silent failure modes the audit kept missing:
//   - paint=0 where geometry exists (filter alias misroute, missing tiles)
//   - projectionName != requested after setProjection (alias misroute)
//   - NaN/Infinity in camera state (degenerate matrix from extreme pitch)
//
// All cells use the `dark` demo — countries.geojson is high-res so detail
// noise stays low.

import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

const OUT = path.resolve('e2e/__projection-coverage__')
fs.mkdirSync(OUT, { recursive: true })

// SwiftShader-WebGPU (the CI fallback on GH Linux runners) can't render
// the X-GIS pipeline correctly — pixel-based assertions false-positive
// there. The workflow sets XGIS_SOFTWARE_GPU=1 so we skip the paint
// checks but keep the GPU-independent assertions (NaN matrix, alias
// misroute, console errors) which are the real silent-bug catchers.
const SOFTWARE_GPU = process.env.XGIS_SOFTWARE_GPU === '1'

const PROJECTIONS = [
  'mercator', 'equirectangular', 'natural_earth',
  'orthographic', 'azimuthal_equidistant', 'stereographic',
  'oblique_mercator', 'globe',
] as const

type Cell = {
  paint: number
  projName: string | null
  projType: number | null
  cameraPitch: number | null
  cameraZoom: number | null
  tilesVisible: number | null
  draws: number | null
  triangles: number | null
  consoleErrs: string[]
  hasNaN: boolean
}

async function snapshot(page: Page): Promise<Cell> {
  const cam = await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: any }).__xgisMap
    if (!m) return null
    const sources: any[] = []
    m.vtSources?.forEach?.((s: any) => {
      const st = s.renderer?.getDrawStats?.() ?? {}
      sources.push(st)
    })
    const c = m.camera
    const aggregate = sources.reduce((a, s) => ({
      tilesVisible: (a.tilesVisible ?? 0) + (s.tilesVisible ?? 0),
      draws: (a.draws ?? 0) + (s.drawCalls ?? 0),
      triangles: (a.triangles ?? 0) + (s.triangles ?? 0),
    }), { tilesVisible: 0, draws: 0, triangles: 0 })
    const camValues = [c.zoom, c.pitch ?? 0, c.bearing ?? 0]
    return {
      projName: m.getProjectionName?.() ?? m.projectionName ?? null,
      projType: c.projType ?? null,
      cameraPitch: c.pitch ?? 0,
      cameraZoom: c.zoom ?? null,
      hasNaN: camValues.some(v => Number.isNaN(v) || !Number.isFinite(v)),
      ...aggregate,
    }
  })
  const pixels = await page.evaluate(async () => {
    const cv = document.querySelector('canvas') as HTMLCanvasElement | null
    if (!cv) return { nonbg: 0, total: 0 }
    const w = cv.width, h = cv.height
    const off = new OffscreenCanvas(w, h)
    const ctx = off.getContext('2d')!
    ctx.drawImage(cv, 0, 0)
    const d = ctx.getImageData(0, 0, w, h).data
    const xMin = (w * 0.20) | 0, xMax = (w * 0.80) | 0
    const yMin = (h * 0.20) | 0, yMax = (h * 0.80) | 0
    let nonbg = 0, total = 0
    for (let y = yMin; y < yMax; y += 2) {
      for (let x = xMin; x < xMax; x += 2) {
        const i = (y * w + x) * 4
        const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!, a = d[i + 3]!
        total++
        if (a > 4 && (r > 4 || g > 4 || b > 4)) nonbg++
      }
    }
    return { nonbg, total }
  })
  return {
    paint: pixels.total > 0 ? pixels.nonbg / pixels.total : 0,
    projName: cam?.projName ?? null,
    projType: cam?.projType ?? null,
    cameraPitch: cam?.cameraPitch ?? null,
    cameraZoom: cam?.cameraZoom ?? null,
    tilesVisible: cam?.tilesVisible ?? null,
    draws: cam?.draws ?? null,
    triangles: cam?.triangles ?? null,
    consoleErrs: [],
    hasNaN: cam?.hasNaN ?? true,
  }
}

/** Set camera via URL hash mutation. demo-runner's startHashSync
 *  re-applies the camera on hash change — re-uses the existing
 *  page/adapter/shader/tile cache instead of full reload. */
async function setCameraViaHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => { window.location.hash = h }, hash)
  // Hash sync is rAF-driven; one frame is enough to apply, then wait
  // for the next render + any tile fetches to settle.
  await page.waitForTimeout(500)
}

/** Collect-and-assert pattern: one failing cell does NOT stop the sweep.
 *  We accumulate (cell-tag, assertion-error) pairs and assert empty at
 *  the end so the artifact shows the full failure surface. */
function collect(failures: string[], tag: string, fn: () => void): void {
  try { fn() } catch (e) { failures.push(`${tag}: ${(e as Error).message.split('\n')[0]}`) }
}

// ─── 1. ZOOM SWEEP ───────────────────────────────────────────────────────
test.describe('projection-coverage zoom sweep', () => {
  const ZOOMS = [0, 0.5, 1, 4, 8, 12] as const
  for (const proj of PROJECTIONS) {
    test(`zoom_${proj}`, async ({ page }) => {
      test.setTimeout(45_000)
      const errs: string[] = []
      page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
      page.on('pageerror', e => errs.push('PAGEERR: ' + e.message))
      await page.setViewportSize({ width: 768, height: 560 })
      await page.goto(`/demo.html?id=dark&proj=${proj}#${ZOOMS[0]}/0/0`,
        { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => (window as any).__xgisReady === true,
        null, { timeout: 12_000 })
      await page.waitForTimeout(1200)

      const failures: string[] = []
      for (const z of ZOOMS) {
        await setCameraViaHash(page, `#${z}/0/0`)
        const cell = await snapshot(page)
        cell.consoleErrs = errs.slice()
        await page.locator('canvas').first()
          .screenshot({ path: path.join(OUT, `zoom-${proj}-z${z}.png`) })
        fs.writeFileSync(path.join(OUT, `zoom-${proj}-z${z}.json`),
          JSON.stringify(cell, null, 2))

        collect(failures, `z${z}`, () => {
          expect(cell.hasNaN, 'NaN/Infinity in camera state').toBe(false)
          expect(cell.projName, 'projection silently fell back').toBe(proj)
          if (!SOFTWARE_GPU && z >= 1 && proj !== 'oblique_mercator') {
            expect(cell.paint, '0% paint where data should be visible')
              .toBeGreaterThan(0.001)
          }
        })
      }
      expect(failures, `${proj} sweep failures:\n  ${failures.join('\n  ')}`)
        .toEqual([])
    })
  }
})

// ─── 2. PITCH SWEEP ──────────────────────────────────────────────────────
test.describe('projection-coverage pitch sweep', () => {
  const PITCHES = [0, 15, 30, 45, 60, 75] as const
  for (const proj of PROJECTIONS) {
    test(`pitch_${proj}`, async ({ page }) => {
      test.setTimeout(45_000)
      const errs: string[] = []
      page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
      page.on('pageerror', e => errs.push('PAGEERR: ' + e.message))
      await page.setViewportSize({ width: 768, height: 560 })
      // hash format: #zoom/lat/lon/bearing/pitch
      await page.goto(`/demo.html?id=dark&proj=${proj}#3/0/0/0/${PITCHES[0]}`,
        { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => (window as any).__xgisReady === true,
        null, { timeout: 12_000 })
      await page.waitForTimeout(1200)

      const failures: string[] = []
      for (const p of PITCHES) {
        await setCameraViaHash(page, `#3/0/0/0/${p}`)
        const cell = await snapshot(page)
        cell.consoleErrs = errs.slice()
        await page.locator('canvas').first()
          .screenshot({ path: path.join(OUT, `pitch-${proj}-p${p}.png`) })
        fs.writeFileSync(path.join(OUT, `pitch-${proj}-p${p}.json`),
          JSON.stringify(cell, null, 2))

        collect(failures, `p${p}`, () => {
          expect(cell.hasNaN, 'NaN/Infinity in camera state').toBe(false)
          const gpuErrs = errs.filter(e => /WebGPU|shader|matrix|NaN/i.test(e))
          expect(gpuErrs, 'GPU/shader error in console').toHaveLength(0)
        })
      }
      expect(failures, `${proj} pitch failures:\n  ${failures.join('\n  ')}`)
        .toEqual([])
    })
  }
})

// ─── 3. SUDDEN SETPROJECTION SWITCH ──────────────────────────────────────
// Single test runs all 8 switches sequentially from one mounted page.
// Stricter than per-pair isolated tests — also catches "GPU state
// corruption accumulates across N switches" (resource leak class).
test('projection-coverage setProjection switch sequence', async ({ page }) => {
  test.setTimeout(60_000)
  const errs: string[] = []
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
  page.on('pageerror', e => errs.push('PAGEERR: ' + e.message))
  await page.setViewportSize({ width: 768, height: 560 })
  await page.goto(`/demo.html?id=dark&proj=${PROJECTIONS[0]}#2/0/0`,
    { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as any).__xgisReady === true,
    null, { timeout: 12_000 })
  await page.waitForTimeout(1200)

  // Visit every projection at least once, then a couple of round-trips
  // to flush any per-switch resource bloat that would only manifest after
  // repeated transitions.
  const sequence: typeof PROJECTIONS[number][] = [
    ...PROJECTIONS,
    'mercator', 'globe', 'mercator', 'equirectangular', 'mercator',
  ]
  const failures: string[] = []
  for (const target of sequence) {
    await page.evaluate((t) => { (window as any).__xgisMap.setProjection(t) }, target)
    await page.waitForTimeout(800)
    const cell = await snapshot(page)
    cell.consoleErrs = errs.slice()
    await page.locator('canvas').first()
      .screenshot({ path: path.join(OUT, `switch-${target}.png`) })

    collect(failures, `→${target}`, () => {
      expect(cell.projName, `setProjection('${target}') silently no-op`).toBe(target)
      expect(cell.hasNaN, 'NaN camera state after switch').toBe(false)
      if (!SOFTWARE_GPU) {
        expect(cell.paint, '0% paint after switch (resource leak?)')
          .toBeGreaterThan(0.001)
      }
    })
  }
  expect(failures, `switch sequence failures:\n  ${failures.join('\n  ')}`)
    .toEqual([])
})
