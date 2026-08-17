// iter-336 — glyph-atlas stability gate (recommendation C). The "wrong
// character" aliasing class (a label glyph rendered from a slot since
// reassigned to a different codepoint — iter-175 "대전→광역", iter-268
// "Pyongy시ng", iter-273 overflow) can ONLY occur when a slot is
// evicted. The host bumps a generation counter on every eviction
// (iter-190). So at STEADY state (camera fixed), the generation must be
// constant across consecutive frames — a climbing generation means the
// atlas is thrashing (evicting glyphs it still needs) = live aliasing
// risk. Drive dense, high-glyph-diversity bilingual regions (Korea /
// Japan / China cities) where atlas pressure is highest, settle, then
// assert generation stability across steady frames.
//
// #1611 STEP-0 — two additions so a later serial-GPU run can settle the
// multi-page-atlas-growth vs ceiling-holds fork:
//  - a Latin-only CONTROL block (same per-phase zoom/city-count shape,
//    ASCII place names) appended to `phases`, asserted flat through the
//    same offender check. If the bilingual phases churn but this one
//    doesn't, the churn is genuine bilingual/CJK slot pressure; if the
//    control ALSO churns, the probe is measuring invalidate()-driven
//    re-collation rather than real eviction.
//  - `wasLastPrepareFullyResolved()` sampled alongside the generation
//    counter each steady frame (TextStage, map/src/text/text-stage.ts:2156;
//    reachable off `map.textStage` — a pre-existing public field, map/src/
//    map.ts:410 — no production surface was added for this).
// Backend is now pinned via `?forcegl2=1` + an explicit
// `__xgisActiveBackend` assertion so a serial SwiftShader run is
// attributable to a known backend rather than whatever auto-resolved.

import { test, expect } from '@playwright/test'

test('glyph atlas — generation stable at steady state (no aliasing churn)', async ({ page }) => {
  test.setTimeout(320_000)
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.setViewportSize({ width: 414, height: 896 })
  await page.goto('/debug-labels.html?style=openfreemap-bright&forcegl2=1#12/37.5665/126.978', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => !!(window as unknown as { __xgisMap?: unknown }).__xgisMap,
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(9_000)
  // Backend resolves during the map's early boot (well inside the settle
  // wait above); assert AFTER it rather than racing __xgisMap's mere
  // existence, which predates run() finishing.
  const backendMarker = await page.evaluate(
    () => (window as unknown as { __xgisActiveBackend?: string }).__xgisActiveBackend,
  )
  expect(backendMarker, 'window.__xgisActiveBackend under ?forcegl2=1').toBe('webgl2')

  const reports = await page.evaluate(async () => {
    const m = (
      window as unknown as {
        __xgisMap: {
          getCamera(): {
            centerX: number
            centerY: number
            zoom: number
            bearing: number
            pitch: number
            maxZoom: number
          }
          markCameraPositioned(): void
          invalidate?(): void
          getAtlasGeneration(): number | null
          getTileLoadDiagnostic(): Record<string, { catalogLoading: number; uploadQueued: number }>
          // #1611 — S16 skip guard read (map/src/text/text-stage.ts:2156),
          // off the pre-existing public `textStage` field (map/src/map.ts:410).
          textStage?: { wasLastPrepareFullyResolved(): boolean } | null
        }
      }
    ).__xgisMap
    const R = 6378137,
      RAD = Math.PI / 180
    const setView = (lon: number, lat: number, zoom: number) => {
      const c = m.getCamera()
      c.zoom = Math.max(0, Math.min(c.maxZoom, zoom))
      c.centerX = lon * RAD * R
      const cl = Math.max(-85.05, Math.min(85.05, lat))
      c.centerY = Math.log(Math.tan(Math.PI / 4 + (cl * RAD) / 2)) * R
      c.bearing = 0
      c.pitch = 0
      m.markCameraPositioned()
      m.invalidate?.()
    }
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const inflight = () => {
      const d = m.getTileLoadDiagnostic()
      let n = 0
      for (const k in d) n += d[k]!.catalogLoading + d[k]!.uploadQueued
      return n
    }
    const settle = async () => {
      let stable = 0
      for (let i = 0; i < 40; i++) {
        await sleep(400)
        m.invalidate?.()
        if (inflight() === 0) {
          if (++stable >= 2) return
        } else stable = 0
      }
    }
    // Dense, high-glyph-diversity bilingual cities (Latin + CJK/Hangul/
    // Kana → maximal unique-glyph pressure on the atlas).
    const phases: [string, [number, number, number]][] = [
      ['Seoul z13', [126.978, 37.566, 13]],
      ['Tokyo z13', [139.767, 35.681, 13]],
      ['Beijing z13', [116.4, 39.9, 13]],
      ['Korea multi-city z10', [127.6, 36.5, 10]],
      // #1611 — Latin-only CONTROL block, same per-phase zoom/city-count
      // shape as the bilingual set above (three single-city z13 + one
      // multi-city z10), ASCII place names only. Rules out the probe
      // measuring invalidate()-driven re-collation instead of genuine
      // CJK/bilingual slot overflow: if these churn too, the offenders
      // below aren't bilingual-specific.
      ['NYC z13 (Latin control)', [-73.99, 40.75, 13]],
      ['London z13 (Latin control)', [-0.11954, 51.50332, 13]],
      ['Paris z13 (Latin control)', [2.33194, 48.84778, 13]],
      ['W-Europe multi-city z10 (Latin control)', [3.0, 50.5, 10]],
    ]
    const out: { phase: string; gens: number[]; resolved: boolean[] }[] = []
    for (const [name, [lon, lat, z]] of phases) {
      setView(lon, lat, z)
      await settle()
      // Three consecutive STEADY frames (camera unchanged) — generation
      // must not move once the visible glyph set is resident. Sample the
      // S16 skip guard (wasLastPrepareFullyResolved) alongside it: a
      // stable generation next to an unresolved prepare would mean the
      // steady read landed mid glyph-range fetch, not at true rest.
      const gens: number[] = []
      const resolved: boolean[] = []
      for (let i = 0; i < 3; i++) {
        m.invalidate?.()
        await sleep(500)
        gens.push(m.getAtlasGeneration() ?? -1)
        resolved.push(m.textStage?.wasLastPrepareFullyResolved() ?? true)
      }
      out.push({ phase: name, gens, resolved })
    }
    return out
  })

  const offenders: string[] = []
  for (const r of reports) {
    const stable = r.gens.every((g) => g === r.gens[0])
    const genDelta = Math.max(...r.gens) - Math.min(...r.gens)
    const unresolvedCount = r.resolved.filter((ok) => !ok).length
    console.log(
      `[${r.phase}] ${stable ? 'STABLE' : 'CHURNING'} gens=${r.gens.join(',')} ` +
        `genDelta=${genDelta} unresolved=${unresolvedCount}/${r.resolved.length}`,
    )
    if (!stable) offenders.push(`${r.phase}: ${r.gens.join('→')}`)
  }
  console.log(
    `offenders: ${offenders.length ? offenders.join(' | ') : 'none'}; pageErrors: ${errs.length}`,
  )
  expect(errs, errs.slice(0, 3).join(' | ')).toHaveLength(0)
  expect(
    offenders,
    'atlas generation climbing at steady state (eviction thrash → aliasing risk)',
  ).toEqual([])
})
