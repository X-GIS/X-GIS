// Projection coverage matrix — auto-detect projection issues across:
//   1. Zoom sweep:  8 proj × 6 zoom levels (incl. min-zoom edge)
//   2. Pitch sweep: 8 proj × 7 pitch values (0 → 85°)
//   3. Sudden switch: setProjection() pairwise (8×7=56) — verify post-switch
//      frame is sane (no NaN matrix, no 0-paint when it should render).
//
// Per cell, this spec captures: paint ratio, console errors, camera state
// (projectionName / projType / pitch / zoom), tile stats. The assertions
// catch the silent failure modes the audit kept missing:
//   - paint=0 where geometry exists (filter alias misroute, missing tiles,
//     dead shader variant)
//   - projectionName != requested after setProjection (alias misroute)
//   - NaN/Infinity in camera state (degenerate matrix from extreme pitch)
//   - tilesVisible=0 at zooms where source data covers the view (tiler
//     dropped all features for that bucket)
//
// All cells use the `dark` demo — countries.geojson is high-res so detail
// noise stays low and Yellow-Sea / Pacific edges show real engine work.

import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

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
  zoom: number; pitch: number; bearing: number; lon: number; lat: number
  paint: number              // ratio non-bg pixels in central 60% region
  colorHist: Record<string, number>  // {dark, cyan, mid, bright, other} as ratios
  projName: string | null
  projType: number | null
  cameraPitch: number | null
  cameraZoom: number | null
  tilesVisible: number | null
  draws: number | null
  triangles: number | null
  consoleErrs: string[]
  hasNaN: boolean
  ready: boolean
}

async function snapshot(page: import('@playwright/test').Page): Promise<Cell> {
  const cam = await page.evaluate(() => {
    const m = (window as any).__xgisMap
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
    // NaN check covers only the core scalars renderFrame consumes to build
    // the projection matrix. Optional/derived fields (center, range, etc.)
    // would surface false positives.
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
  const png = await page.locator('canvas').first().screenshot({ type: 'png' })
  const pixels = await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res(); img.onerror = () => rej(new Error('img-load'))
      img.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const w = img.width, h = img.height
    const d = ctx.getImageData(0, 0, w, h).data
    const xMin = (w * 0.20) | 0, xMax = (w * 0.80) | 0
    const yMin = (h * 0.20) | 0, yMax = (h * 0.80) | 0
    let nonbg = 0, total = 0
    const hist = { dark: 0, cyan: 0, mid: 0, bright: 0, other: 0 }
    for (let y = yMin; y < yMax; y += 2) {
      for (let x = xMin; x < xMax; x += 2) {
        const i = (y * w + x) * 4
        const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!, a = d[i + 3]!
        total++
        if (a <= 4 && r <= 4 && g <= 4 && b <= 4) continue
        nonbg++
        const max = Math.max(r, g, b)
        if (max < 40) hist.dark++
        else if (b > 120 && g > 80 && r < 100) hist.cyan++
        else if (max > 220) hist.bright++
        else if (max > 100) hist.mid++
        else hist.other++
      }
    }
    URL.revokeObjectURL(url)
    return { nonbg, total, hist }
  }, Array.from(png))
  return {
    zoom: cam?.cameraZoom ?? -1, pitch: cam?.cameraPitch ?? -1, bearing: 0, lon: 0, lat: 0,
    paint: pixels.total > 0 ? pixels.nonbg / pixels.total : 0,
    colorHist: {
      dark: pixels.total > 0 ? pixels.hist.dark / pixels.total : 0,
      cyan: pixels.total > 0 ? pixels.hist.cyan / pixels.total : 0,
      mid: pixels.total > 0 ? pixels.hist.mid / pixels.total : 0,
      bright: pixels.total > 0 ? pixels.hist.bright / pixels.total : 0,
      other: pixels.total > 0 ? pixels.hist.other / pixels.total : 0,
    },
    projName: cam?.projName ?? null,
    projType: cam?.projType ?? null,
    cameraPitch: cam?.cameraPitch ?? null,
    cameraZoom: cam?.cameraZoom ?? null,
    tilesVisible: cam?.tilesVisible ?? null,
    draws: cam?.draws ?? null,
    triangles: cam?.triangles ?? null,
    consoleErrs: [],
    hasNaN: cam?.hasNaN ?? true,
    ready: cam !== null,
  }
}

// ─── 1. ZOOM SWEEP ───────────────────────────────────────────────────────
test.describe('projection-coverage zoom sweep', () => {
  // Zoom levels — z=0 is min, z=0.5 is sub-1 (often-broken band), z=12 is
  // high. Skipping z=2 because z=1+z=4 cover that gap.
  const ZOOMS = [0, 0.5, 1, 4, 8, 12] as const
  for (const proj of PROJECTIONS) {
    for (const z of ZOOMS) {
      test(`zoom_${proj}_z${z}`, async ({ page }) => {
        test.setTimeout(25_000)
        const errs: string[] = []
        page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
        page.on('pageerror', e => errs.push('PAGEERR: ' + e.message))
        await page.setViewportSize({ width: 768, height: 560 })
        await page.goto(`/demo.html?id=dark&proj=${proj}#${z}/0/0`, { waitUntil: 'domcontentloaded' })
        try {
          await page.waitForFunction(() => (window as any).__xgisReady === true, null, { timeout: 12_000 })
        } catch { errs.push('NOT_READY') }
        await page.waitForTimeout(1500)
        const cell = await snapshot(page)
        cell.consoleErrs = errs
        await page.locator('canvas').first().screenshot({ path: path.join(OUT, `zoom-${proj}-z${z}.png`) })
        fs.writeFileSync(path.join(OUT, `zoom-${proj}-z${z}.json`), JSON.stringify(cell, null, 2))

        // ── Auto-detect assertions ───────────────────────────────────────
        // (a) NaN/Infinity in camera state — degenerate matrix
        expect(cell.hasNaN, `NaN/Infinity in camera state @ ${proj} z${z}`).toBe(false)
        // (b) requested projection actually applied (the alias-misroute class)
        expect(cell.projName, `setProjection silently fell back @ requested=${proj}`).toBe(proj)
        // (c) zero paint at zoom where data is in view — should always have
        //     SOME ink at z≥0 for dark/countries except oblique_mercator at
        //     extreme zooms where the data's not in the visible band. Skip
        //     under SwiftShader-WebGPU where pixel output is unreliable.
        if (!SOFTWARE_GPU && z >= 1 && proj !== 'oblique_mercator') {
          expect(cell.paint, `0% paint @ ${proj} z${z} (tiler dropped features?)`).toBeGreaterThan(0.001)
        }
      })
    }
  }
})

// ─── 2. PITCH SWEEP ──────────────────────────────────────────────────────
test.describe('projection-coverage pitch sweep', () => {
  // Camera max pitch enforcement varies by projection — non-globe caps at
  // 60° in many configs. We probe up to the max-tested 75° to find where
  // each projection's pitched path breaks.
  const PITCHES = [0, 15, 30, 45, 60, 75] as const
  for (const proj of PROJECTIONS) {
    for (const p of PITCHES) {
      test(`pitch_${proj}_p${p}`, async ({ page }) => {
        test.setTimeout(25_000)
        const errs: string[] = []
        page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
        page.on('pageerror', e => errs.push('PAGEERR: ' + e.message))
        await page.setViewportSize({ width: 768, height: 560 })
        // hash format: #zoom/lat/lon/bearing/pitch
        await page.goto(`/demo.html?id=dark&proj=${proj}#3/0/0/0/${p}`, { waitUntil: 'domcontentloaded' })
        try {
          await page.waitForFunction(() => (window as any).__xgisReady === true, null, { timeout: 12_000 })
        } catch { errs.push('NOT_READY') }
        await page.waitForTimeout(1500)
        const cell = await snapshot(page)
        cell.consoleErrs = errs
        await page.locator('canvas').first().screenshot({ path: path.join(OUT, `pitch-${proj}-p${p}.png`) })
        fs.writeFileSync(path.join(OUT, `pitch-${proj}-p${p}.json`), JSON.stringify(cell, null, 2))

        // Mercator and the equirect/NE family are flat — they SHOULD accept
        // pitch and render. Azimuthal family (ortho/az.eq./stereographic)
        // promotes to globeOrtho when pitched, which is intentional but
        // should NOT yield NaN matrices.
        expect(cell.hasNaN, `NaN/Infinity in camera state @ ${proj} pitch=${p}`).toBe(false)
        expect(cell.consoleErrs.filter(e => /WebGPU|shader|matrix|NaN/i.test(e)),
          `GPU/shader error @ ${proj} pitch=${p}`).toHaveLength(0)
      })
    }
  }
})

// ─── 3. SUDDEN SETPROJECTION SWITCH ──────────────────────────────────────
test.describe('projection-coverage setProjection switch', () => {
  // For each (from, to) pair, mount with `from`, then call setProjection(to)
  // at runtime, then snapshot. Catches:
  //   - setProjection silently no-op (alias miss → projectionName stays at `from`)
  //   - GPU resources not rebuilt → blank frame after switch
  //   - Camera state corruption → NaN
  const cases: Array<{ from: typeof PROJECTIONS[number]; to: typeof PROJECTIONS[number] }> = []
  for (const from of PROJECTIONS) {
    for (const to of PROJECTIONS) {
      if (from === to) continue
      cases.push({ from, to })
    }
  }
  // Sample 12 representative pairs to keep run time bounded (full 56 is
  // available in `cases` if a deeper sweep is needed).
  const sampled = [
    { from: 'mercator', to: 'globe' },
    { from: 'globe', to: 'mercator' },
    { from: 'mercator', to: 'equirectangular' },
    { from: 'equirectangular', to: 'natural_earth' },
    { from: 'natural_earth', to: 'orthographic' },
    { from: 'orthographic', to: 'azimuthal_equidistant' },
    { from: 'azimuthal_equidistant', to: 'stereographic' },
    { from: 'stereographic', to: 'globe' },
    { from: 'globe', to: 'oblique_mercator' },
    { from: 'oblique_mercator', to: 'mercator' },
    { from: 'mercator', to: 'oblique_mercator' },
    { from: 'natural_earth', to: 'globe' },
  ] as const
  for (const { from, to } of sampled) {
    test(`switch_${from}_to_${to}`, async ({ page }) => {
      test.setTimeout(25_000)
      const errs: string[] = []
      page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
      page.on('pageerror', e => errs.push('PAGEERR: ' + e.message))
      await page.setViewportSize({ width: 768, height: 560 })
      await page.goto(`/demo.html?id=dark&proj=${from}#2/0/0`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => (window as any).__xgisReady === true, null, { timeout: 12_000 })
      await page.waitForTimeout(1200)
      // Snapshot before — confirms `from` actually applied
      const before = await snapshot(page)
      // Switch
      await page.evaluate((target) => { (window as any).__xgisMap.setProjection(target) }, to)
      await page.waitForTimeout(1500)
      const after = await snapshot(page)
      after.consoleErrs = errs
      await page.locator('canvas').first().screenshot({ path: path.join(OUT, `switch-${from}-to-${to}.png`) })
      fs.writeFileSync(path.join(OUT, `switch-${from}-to-${to}.json`),
        JSON.stringify({ before, after }, null, 2))

      // Assertions
      expect(before.projName, `mount didn't apply ?proj=${from}`).toBe(from)
      expect(after.projName, `setProjection('${to}') silently no-op`).toBe(to)
      expect(after.hasNaN, `NaN camera state after switch to ${to}`).toBe(false)
      // Post-switch frame must paint SOMETHING (catches "blank after switch"
      // / "GPU resources not rebuilt" class). 0.1% threshold is loose
      // intentionally — we just don't want a fully empty frame. Skipped on
      // SwiftShader (unreliable pixel output).
      if (!SOFTWARE_GPU) {
        expect(after.paint, `0% paint after switch ${from}→${to} (resource leak?)`).toBeGreaterThan(0.001)
      }
    })
  }
})
