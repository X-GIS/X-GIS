// ═══════════════════════════════════════════════════════════════════
// Label anchor PARITY gate — X-GIS vs MapLibre, position not pixels
// ═══════════════════════════════════════════════════════════════════
//
// The labels pixel-match survey (_pixel-match-survey-labels) CANNOT gate
// label fidelity: a multi-threshold A/B proved that adding correctly-placed
// labels lowers the X-GIS↔MapLibre pixel-match at EVERY tolerance (through
// delta<=128) because the two engines render different label SETS + font/halo,
// so label ink never pixel-aligns. Label fidelity must be gated on POSITION,
// which is immune to those rasterization confounds.
//
// This gate matches X-GIS placed label anchors to MapLibre point-symbol
// features by text and asserts the VERTICAL residual (ry) is sub-pixel:
//   ry = xgis.anchorY - mapLibre.project(lonlat).y
// anchorY is the vertical label-anchor center on both sides, so ry is the
// clean projection-parity signal. (anchorX is the glyph-run LEFT edge vs
// MapLibre's CENTER, offset by ~half the rendered text width — so the
// horizontal axis is intentionally NOT asserted here.)
//
// Companion to _projection-label-onscreen (which asserts anchors stay on
// screen across all 8 projections). Together they gate "labels land on their
// features", the real label-fidelity invariant. Real chromium WebGPU.
import { test, expect } from '@playwright/test'

// OFM Positron Seoul z14.16 — dense single-anchor point place-labels (동/-dong),
// sparse icons, so text->feature matching is clean and the line-label
// along-curve confound (which inflates ry in road-dense views) is minimal.
const VIEW = { style: 'openfreemap-positron', hash: '#14.16/37.57197/126.98361' }

test('label anchor vertical parity vs MapLibre (point labels)', async ({ page }) => {
  test.setTimeout(120_000)
  const errs: string[] = []
  page.on('pageerror', e => errs.push(String(e)))
  await page.setViewportSize({ width: 1400, height: 760 })
  await page.goto(`/compare.html?style=${VIEW.style}${VIEW.hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
    return w.__xgisReady === true && w.__mlReady === true
  }, null, { timeout: 60_000 })
  await page.waitForTimeout(8000)
  // Trigger the label dump, then wait a frame so getDumpedLabels populates.
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap: { setLabelDumpFilter(s: string): void; invalidate?(): void } }
    w.__xgisMap.setLabelDumpFilter(''); w.__xgisMap.invalidate?.()
  })
  await page.waitForTimeout(900)

  const out = await page.evaluate(() => {
    const w = window as unknown as {
      __xgisMap: { getDumpedLabels(): Array<{ text: string; anchorX: number; anchorY: number; curved: boolean }> | null }
      __mlMap: { queryRenderedFeatures(g?: unknown, o?: unknown): Array<{ geometry: { type: string; coordinates: number[] }; layer: { type: string } ; properties: Record<string, unknown> }>; project(ll: [number, number]): { x: number; y: number } }
    }
    const dpr = window.devicePixelRatio || 1
    const NL = String.fromCharCode(10)
    const xl = w.__xgisMap.getDumpedLabels() ?? []
    const feats = w.__mlMap.queryRenderedFeatures(undefined, {}).filter(f => f.layer.type === 'symbol' && f.geometry.type === 'Point')
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().split(' ').filter(Boolean).join(' ')
    const mlMap = new Map<string, [number, number]>()
    for (const f of feats) for (const k of ['name', 'name:latin', 'name_en', 'name:en', 'name:ko', 'name:nonlatin']) {
      const v = f.properties[k]; if (typeof v === 'string' && v.trim()) { const key = norm(v); if (!mlMap.has(key)) mlMap.set(key, f.geometry.coordinates as [number, number]) }
    }
    const rys: number[] = []
    for (const l of xl) {
      if (l.curved) continue
      const lines = l.text.split(NL).join(' ').split(' ').map(norm).filter(Boolean)
      let ll: [number, number] | undefined
      for (const ln of lines) { if (mlMap.has(ln)) { ll = mlMap.get(ln); break } }
      if (!ll) continue
      const ry = Math.abs(l.anchorY / dpr - w.__mlMap.project(ll).y)
      if (ry < 40) rys.push(ry) // drop same-name text-collision mismatches
    }
    rys.sort((a, b) => a - b)
    return {
      matched: rys.length,
      ryMedian: rys.length ? rys[Math.floor(rys.length / 2)]! : -1,
      ryP75: rys.length ? rys[Math.floor(rys.length * 0.75)]! : -1,
      under2pct: rys.length ? 100 * rys.filter(r => r < 2).length / rys.length : -1,
    }
  })
  // eslint-disable-next-line no-console
  console.log('ANCHOR_PARITY ' + JSON.stringify(out))
  expect(errs, errs.slice(0, 3).join(' | ')).toHaveLength(0)
  expect(out.matched, 'matched point labels (text -> ML feature)').toBeGreaterThanOrEqual(10)
  // Anchor projection parity: X-GIS places label anchors at the same screen
  // position as MapLibre to within a pixel. (Seoul baseline: median 0px.)
  expect(out.ryMedian, 'median vertical anchor residual vs MapLibre (px)').toBeLessThan(2)
  expect(out.ryP75, 'p75 vertical anchor residual vs MapLibre (px)').toBeLessThan(4)
})
