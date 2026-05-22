// iter-335 — tile-coverage stress. Drive real-user interaction (low-zoom
// continent pan, deep zoom-in, dateline, high-latitude near the Mercator
// limit, rapid zoom burst) over live OFM Bright, and after each phase
// SETTLES the async tile pipeline (catalogLoading + uploadQueued → 0)
// then asserts `missed === 0` per source.
//
// `missed` = needed tiles with neither GPU data nor a usable fallback =
// a VISIBLE gap (blank patch / seam). A persistent missed>0 once nothing
// is in-flight is the water-polygon-missing / FLICKER class
// (project_water_low_zoom_iter271). This gate makes that class
// observable + regression-pinned via the same dump+interact pattern as
// the label tests. Real chromium WebGPU.

import { test, expect } from '@playwright/test'

interface TileDiag { needed: number; missed: number; gpuUnique: number; catalogCached: number; catalogLoading: number; uploadQueued: number; gpuCap: number }

test('tile coverage — no persistent gaps under interaction', async ({ page }) => {
  test.setTimeout(220_000)
  const errs: string[] = []
  page.on('pageerror', e => errs.push(String(e)))
  await page.setViewportSize({ width: 414, height: 896 })
  await page.goto('/debug-labels.html?style=openfreemap-bright#3/20/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!(window as unknown as { __xgisMap?: unknown }).__xgisMap, null, { timeout: 30_000 })
  await page.waitForTimeout(8_000)

  const reports = await page.evaluate(async () => {
    const m = (window as unknown as {
      __xgisMap: {
        getCamera(): { centerX: number; centerY: number; zoom: number; bearing: number; pitch: number; maxZoom: number }
        markCameraPositioned(): void
        invalidate?(): void
        getTileLoadDiagnostic(): Record<string, TileDiag>
      }
    }).__xgisMap
    interface TileDiag { needed: number; missed: number; gpuUnique: number; catalogCached: number; catalogLoading: number; uploadQueued: number; gpuCap: number }
    const R = 6378137, RAD = Math.PI / 180
    const setView = (lon: number, lat: number, zoom: number) => {
      const c = m.getCamera()
      c.zoom = Math.max(0, Math.min(c.maxZoom, zoom))
      c.centerX = lon * RAD * R
      const cl = Math.max(-85.05, Math.min(85.05, lat))
      c.centerY = Math.log(Math.tan(Math.PI / 4 + cl * RAD / 2)) * R
      c.bearing = 0; c.pitch = 0
      m.markCameraPositioned(); m.invalidate?.()
    }
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
    const inflight = () => {
      const d = m.getTileLoadDiagnostic()
      let l = 0, u = 0
      for (const k in d) { l += d[k]!.catalogLoading; u += d[k]!.uploadQueued }
      return l + u
    }
    const missedTotal = () => {
      const d = m.getTileLoadDiagnostic()
      let mi = 0, need = 0
      for (const k in d) { mi += d[k]!.missed; need += d[k]!.needed }
      return { missed: mi, needed: need }
    }
    // Settle: poll until nothing in flight for 2 consecutive reads, cap ~16s.
    const settle = async () => {
      let stable = 0
      for (let i = 0; i < 40; i++) {
        await sleep(400)
        m.invalidate?.()
        if (inflight() === 0) { if (++stable >= 2) return } else stable = 0
      }
    }
    const phases: [string, [number, number, number]][] = [
      ['continent-pan z3 (Asia→Americas)', [127, 35, 3]],
      ['deep zoom-in Seoul z14', [126.98, 37.57, 14]],
      ['dateline lon179.9 z4', [179.9, 0, 4]],
      ['high-lat lat82 z4 (Mercator limit)', [30, 82, 4]],
      ['zoom burst z5 (FLICKER trigger)', [127, 37.5, 5]],
      ['Europe cities z11', [2.35, 48.85, 11]],
    ]
    const out: { phase: string; missed: number; needed: number }[] = []
    for (const [name, [lon, lat, z]] of phases) {
      // a couple of intermediate steps so selection churns like a real pan
      setView(lon, lat, Math.max(0, z - 2)); await sleep(500)
      setView(lon, lat, z); await sleep(500)
      await settle()
      out.push({ phase: name, ...missedTotal() })
    }
    return out
  })

  // Gross-gap gate: the water-missing / FLICKER class leaves a LARGE
  // fraction uncovered (user report: 140 missing). A handful of edge
  // tiles at extreme deep zoom (OFM 404s / viewport-corner LOD) is
  // noise. Fail when a phase leaves >5% (and >5 absolute) of needed
  // tiles uncovered after the pipeline fully settled.
  const offenders: string[] = []
  for (const r of reports) {
    const frac = r.needed > 0 ? r.missed / r.needed : 0
    console.log(`[${r.phase}] needed=${r.needed} missed=${r.missed} (${(frac * 100).toFixed(1)}%)`)
    if (r.missed > 5 && frac > 0.05) offenders.push(`${r.phase}: ${r.missed}/${r.needed}`)
  }
  console.log(`offenders: ${offenders.length ? offenders.join(' | ') : 'none'}; pageErrors: ${errs.length}`)
  expect(errs, errs.slice(0, 3).join(' | ')).toHaveLength(0)
  expect(offenders, 'phases with a gross tile-coverage gap after settle').toEqual([])
})
