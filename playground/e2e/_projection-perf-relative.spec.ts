// iter-339 — relative projection perf (recommendation F). Absolute
// frame-time gates (p95 < 50ms) are environment-dependent (local GPU vs
// CI SwiftShader) → flaky. RELATIVE perf is env-independent: drive the
// SAME pan interaction under each projection and assert none is
// dramatically slower than Mercator. The non-Mercator over-select class
// (memory project_non_merc_z14_pitch_over_select: sphere-routed projs
// selected 1322 tiles vs Mercator 297 → 5-7 fps) shows up as a 4-7×
// frame-time ratio. Real chromium WebGPU; ratios cancel the host speed.

import { test, expect } from '@playwright/test'
import { runInteraction, computeStats, interactions } from './helpers/natural-interaction'

const PROJECTIONS = [
  'mercator', 'globe', 'orthographic', 'equirectangular',
  'natural_earth', 'stereographic', 'azimuthal_equidistant', 'oblique_mercator',
]

async function setProjAndSettle(page: import('@playwright/test').Page, proj: string): Promise<void> {
  await page.evaluate((p) => {
    const m = (window as unknown as {
      __xgisMap: { setProjection(n: string): void; getCamera(): { centerX: number; centerY: number; zoom: number; bearing: number; pitch: number; maxZoom: number }; markCameraPositioned(): void; invalidate?(): void }
    }).__xgisMap
    m.setProjection(p)
    const R = 6378137, RAD = Math.PI / 180
    const c = m.getCamera()
    c.zoom = 9; c.centerX = 127.6 * RAD * R
    c.centerY = Math.log(Math.tan(Math.PI / 4 + 36.5 * RAD / 2)) * R
    c.bearing = 0; c.pitch = 0
    m.markCameraPositioned(); m.invalidate?.()
  }, proj)
  // settle tiles before timing
  await page.waitForFunction(() => {
    const m = (window as unknown as { __xgisMap?: { getTileLoadDiagnostic(): Record<string, { catalogLoading: number; uploadQueued: number }>; invalidate?(): void } }).__xgisMap
    if (!m) return false
    m.invalidate?.()
    const d = m.getTileLoadDiagnostic()
    let n = 0; for (const k in d) n += d[k]!.catalogLoading + d[k]!.uploadQueued
    return n === 0
  }, null, { timeout: 25_000 }).catch(() => {})
  await page.waitForTimeout(800)
}

test('relative projection perf — no projection is dramatically slower than Mercator', async ({ page }) => {
  test.setTimeout(200_000)
  const errs: string[] = []
  page.on('pageerror', e => errs.push(String(e)))
  await page.setViewportSize({ width: 800, height: 800 })
  await page.goto('/debug-labels.html?style=openfreemap-bright#9/36.5/127.6', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!(window as unknown as { __xgisMap?: unknown }).__xgisMap, null, { timeout: 30_000 })
  await page.waitForTimeout(7_000)

  const stats: Record<string, { median: number; p95: number }> = {}
  for (const proj of PROJECTIONS) {
    await setProjAndSettle(page, proj)
    // Identical pan over Korea for every projection.
    const timings = await runInteraction(
      page,
      interactions.pan({ lng: 126.5, lat: 36.0 }, { lng: 129.0, lat: 37.8 }),
      { durationMs: 3500 },
    )
    const s = computeStats(timings)
    stats[proj] = { median: s.median, p95: s.p95 }
    console.log(`[${proj}] median=${s.median.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms (${s.count} frames)`)
  }

  const base = stats['mercator']!
  const offenders: string[] = []
  for (const proj of PROJECTIONS) {
    if (proj === 'mercator') continue
    const r = stats[proj]!
    const medRatio = r.median / Math.max(base.median, 0.5)
    const p95Ratio = r.p95 / Math.max(base.p95, 0.5)
    // 4× Mercator = the over-select regression band (observed 5-7×).
    if (medRatio > 4 || p95Ratio > 4) offenders.push(`${proj}: median ${medRatio.toFixed(1)}× p95 ${p95Ratio.toFixed(1)}×`)
  }
  console.log(`mercator baseline median=${base.median.toFixed(1)} p95=${base.p95.toFixed(1)}; offenders: ${offenders.length ? offenders.join(' | ') : 'none'}`)
  expect(errs, errs.slice(0, 3).join(' | ')).toHaveLength(0)
  expect(offenders, 'projections >4× slower than Mercator (over-select regression)').toEqual([])
})
