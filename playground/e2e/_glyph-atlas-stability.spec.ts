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
// assert generation stability across steady frames. Real chromium WebGPU.

import { test, expect } from '@playwright/test'

test('glyph atlas — generation stable at steady state (no aliasing churn)', async ({ page }) => {
  test.setTimeout(220_000)
  const errs: string[] = []
  page.on('pageerror', e => errs.push(String(e)))
  await page.setViewportSize({ width: 414, height: 896 })
  await page.goto('/debug-labels.html?style=openfreemap-bright#12/37.5665/126.978', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!(window as unknown as { __xgisMap?: unknown }).__xgisMap, null, { timeout: 30_000 })
  await page.waitForTimeout(9_000)

  const reports = await page.evaluate(async () => {
    const m = (window as unknown as {
      __xgisMap: {
        getCamera(): { centerX: number; centerY: number; zoom: number; bearing: number; pitch: number; maxZoom: number }
        markCameraPositioned(): void
        invalidate?(): void
        getAtlasGeneration(): number | null
        getTileLoadDiagnostic(): Record<string, { catalogLoading: number; uploadQueued: number }>
      }
    }).__xgisMap
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
      let n = 0
      for (const k in d) n += d[k]!.catalogLoading + d[k]!.uploadQueued
      return n
    }
    const settle = async () => {
      let stable = 0
      for (let i = 0; i < 40; i++) {
        await sleep(400); m.invalidate?.()
        if (inflight() === 0) { if (++stable >= 2) return } else stable = 0
      }
    }
    // Dense, high-glyph-diversity bilingual cities (Latin + CJK/Hangul/
    // Kana → maximal unique-glyph pressure on the atlas).
    const phases: [string, [number, number, number]][] = [
      ['Seoul z13', [126.978, 37.566, 13]],
      ['Tokyo z13', [139.767, 35.681, 13]],
      ['Beijing z13', [116.40, 39.90, 13]],
      ['Korea multi-city z10', [127.6, 36.5, 10]],
    ]
    const out: { phase: string; gens: number[] }[] = []
    for (const [name, [lon, lat, z]] of phases) {
      setView(lon, lat, z)
      await settle()
      // Three consecutive STEADY frames (camera unchanged) — generation
      // must not move once the visible glyph set is resident.
      const gens: number[] = []
      for (let i = 0; i < 3; i++) {
        m.invalidate?.(); await sleep(500)
        gens.push(m.getAtlasGeneration() ?? -1)
      }
      out.push({ phase: name, gens })
    }
    return out
  })

  const offenders: string[] = []
  for (const r of reports) {
    const stable = r.gens.every(g => g === r.gens[0])
    console.log(`[${r.phase}] steady-frame generations: ${r.gens.join(',')} ${stable ? 'STABLE' : 'CHURNING'}`)
    if (!stable) offenders.push(`${r.phase}: ${r.gens.join('→')}`)
  }
  console.log(`offenders: ${offenders.length ? offenders.join(' | ') : 'none'}; pageErrors: ${errs.length}`)
  expect(errs, errs.slice(0, 3).join(' | ')).toHaveLength(0)
  expect(offenders, 'atlas generation climbing at steady state (eviction thrash → aliasing risk)').toEqual([])
})
