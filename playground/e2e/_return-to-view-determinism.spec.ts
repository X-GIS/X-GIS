// iter-337 — return-to-view determinism (recommendation G, self-diff
// variant). A view rendered fresh, then returned to AFTER heavy
// interaction (zoom out to the world, pan to another continent, zoom
// back in), must look the SAME. Differences = motion-induced
// non-determinism the static pixel-match can't see: stale-tile residue
// after a pan, label/collision state not restored, GPU shader/bundle
// state leaked across frames (the #1 GPU blind-spot). Self-comparison
// (X-GIS vs X-GIS) avoids the MapLibre-diff noise so the threshold is
// tight. Real chromium WebGPU.

import { test, expect } from '@playwright/test'
import { captureCanvas, pixelDiffRatio } from './helpers/visual'

const VIEWS: [string, number, number, number][] = [
  ['Seoul z13', 126.978, 37.566, 13],
  ['Paris z12', 2.349, 48.857, 12],
  ['dateline z4', 179.5, 0, 4],
]

async function setViewAndSettle(page: import('@playwright/test').Page, lon: number, lat: number, zoom: number): Promise<void> {
  await page.evaluate(({ lon, lat, zoom }) => {
    const m = (window as unknown as {
      __xgisMap: { getCamera(): { centerX: number; centerY: number; zoom: number; bearing: number; pitch: number; maxZoom: number }; markCameraPositioned(): void; invalidate?(): void }
    }).__xgisMap
    const R = 6378137, RAD = Math.PI / 180
    const c = m.getCamera()
    c.zoom = Math.max(0, Math.min(c.maxZoom, zoom))
    c.centerX = lon * RAD * R
    const cl = Math.max(-85.05, Math.min(85.05, lat))
    c.centerY = Math.log(Math.tan(Math.PI / 4 + cl * RAD / 2)) * R
    c.bearing = 0; c.pitch = 0
    m.markCameraPositioned(); m.invalidate?.()
  }, { lon, lat, zoom })
  // settle: poll the tile pipeline to quiescence
  await page.waitForFunction(() => {
    const m = (window as unknown as { __xgisMap?: { getTileLoadDiagnostic(): Record<string, { catalogLoading: number; uploadQueued: number }>; invalidate?(): void } }).__xgisMap
    if (!m) return false
    m.invalidate?.()
    const d = m.getTileLoadDiagnostic()
    let n = 0; for (const k in d) n += d[k]!.catalogLoading + d[k]!.uploadQueued
    return n === 0
  }, null, { timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(1_200)
}

test('return-to-view determinism — same view renders the same after interaction', async ({ page }) => {
  test.setTimeout(240_000)
  const errs: string[] = []
  page.on('pageerror', e => errs.push(String(e)))
  await page.setViewportSize({ width: 800, height: 800 })
  await page.goto('/debug-labels.html?style=openfreemap-bright#13/37.566/126.978', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!(window as unknown as { __xgisMap?: unknown }).__xgisMap, null, { timeout: 30_000 })
  await page.waitForTimeout(8_000)

  const offenders: string[] = []
  for (const [name, lon, lat, z] of VIEWS) {
    // Fresh capture at the view.
    await setViewAndSettle(page, lon, lat, z)
    const before = await captureCanvas(page)
    // Heavy interaction AWAY: world zoom-out, jump to the antipode-ish
    // region, deep zoom there, then come back to the exact view.
    await setViewAndSettle(page, lon, lat, 3)
    await setViewAndSettle(page, lon + 150, -Math.sign(lat) * 30 - (lat === 0 ? 20 : 0), 11)
    await setViewAndSettle(page, lon, lat, z)  // exact return
    const after = await captureCanvas(page)

    const ratio = await pixelDiffRatio(page, before, after, 16)
    console.log(`[${name}] return-to-view pixel diff: ${(ratio * 100).toFixed(2)}%`)
    if (ratio > 0.02) offenders.push(`${name}: ${(ratio * 100).toFixed(2)}%`)
  }
  console.log(`offenders: ${offenders.length ? offenders.join(' | ') : 'none'}; pageErrors: ${errs.length}`)
  expect(errs, errs.slice(0, 3).join(' | ')).toHaveLength(0)
  expect(offenders, 'views that differ after interaction (stale-tile/state-leak residue)').toEqual([])
})
