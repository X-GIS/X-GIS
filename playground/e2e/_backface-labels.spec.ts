// THROWAWAY capture spec for the globe/ortho back-face label cull fix
// (fix/globe-backface-labels). NOT a gate — it only writes PNGs to
// .omc/shots/userbug/ for the main agent to eyeball. Delete after review.
//
// Bug: on Orthographic + true Globe, labels on the FAR hemisphere render
// THROUGH the globe (not occluded), especially when pitched. The fix adds a
// horizon/back-face cull to the ECEF/globe label projector mirroring the globe
// tile selector. This spec captures:
//   (a) TRUE GLOBE      — far-side labels must be GONE after the fix
//   (b) ORTHO + pitch45 — same check
//   (c) EQUIRECT (flat) — CONTROL: labels unchanged (fix must not touch flat)
//
// Run twice to get a before/after pair:
//   SHOT_TAG=before  (on main / with the fix stashed)
//   SHOT_TAG=after   (with the fix applied)  ← default
// Real chromium WebGPU (HEADED=1, system GPU). No XGIS_SOFTWARE_GPU.

import { test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const W = 900, H = 900
const TAG = process.env.SHOT_TAG ?? 'after'
// Repo-root anchored (playwright cwd is playground/); avoids ESM __dirname.
const OUT = resolve(process.cwd(), '../.omc/shots/userbug')

// Centre over the empty Pacific so the label-DENSE Eurasia/Africa landmass
// sits on the FAR hemisphere of the disc. Before the fix those continental
// labels smear across the empty Pacific front (the reported bug); after, they
// vanish at the horizon, leaving the near (Pacific/Americas-rim) labels intact.
const CENTER_LON = -160
const CENTER_LAT = 10
const ZOOM = 2.6

interface MapAPI {
  setProjection(n: string): void
  getCamera(): { centerX: number; centerY: number; zoom: number; bearing: number; pitch: number }
  markCameraPositioned(): void
  invalidate?(): void
  setLabelDumpFilter(s: string): void
  getDumpedLabels(): Array<{ anchorX: number; anchorY: number; text: string }> | null
  getTileLoadDiagnostic(): Record<string, { catalogLoading: number; uploadQueued: number }>
}

test('capture back-face label cull (globe / ortho-pitch / flat-control)', async ({ page }) => {
  test.setTimeout(220_000)
  mkdirSync(OUT, { recursive: true })
  const errs: string[] = []
  page.on('pageerror', e => errs.push(String(e)))
  await page.setViewportSize({ width: W, height: H })
  await page.goto('/debug-labels.html?style=openfreemap-bright#3/10/-160', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!(window as unknown as { __xgisMap?: unknown }).__xgisMap, null, { timeout: 30_000 })
  await page.waitForTimeout(8_000)

  const scenes: Array<{ proj: string; pitch: number; file: string }> = [
    { proj: 'globe', pitch: 0, file: `30-backface-globe-${TAG}.png` },
    { proj: 'orthographic', pitch: 45, file: `31-backface-ortho-pitch-${TAG}.png` },
    { proj: 'equirectangular', pitch: 0, file: `32-backface-flat-control-${TAG}.png` },
  ]

  for (const s of scenes) {
    const count = await page.evaluate(async ({ proj, pitch, lon, lat, zoom }) => {
      const m = (window as unknown as { __xgisMap: MapAPI }).__xgisMap
      const R = 6378137, RAD = Math.PI / 180
      m.setProjection(proj)
      const c = m.getCamera()
      c.zoom = zoom
      c.centerX = lon * RAD * R
      c.centerY = Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2)) * R
      c.bearing = 0
      c.pitch = pitch
      m.markCameraPositioned(); m.invalidate?.()
      const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
      // settle: wait for tile loads to drain (glyph load can need 3-5s)
      let st = 0
      for (let i = 0; i < 40; i++) {
        await sleep(400); m.invalidate?.()
        const d = m.getTileLoadDiagnostic(); let n = 0
        for (const k in d) n += d[k]!.catalogLoading + d[k]!.uploadQueued
        if (n === 0) { if (++st >= 3) break } else st = 0
      }
      // extra settle so glyph atlas + label placement finish
      await sleep(2500); m.invalidate?.(); await sleep(800)
      m.setLabelDumpFilter(''); m.invalidate?.(); await sleep(500)
      const labels = m.getDumpedLabels() ?? []
      return labels.length
    }, { proj: s.proj, pitch: s.pitch, lon: CENTER_LON, lat: CENTER_LAT, zoom: ZOOM })

    await page.waitForTimeout(400)
    await page.screenshot({ path: resolve(OUT, s.file) })
    console.log(`[${s.proj} pitch=${s.pitch}] labels=${count} -> ${s.file}`)
  }
  console.log(`pageErrors: ${errs.length}${errs.length ? ' :: ' + errs.slice(0, 3).join(' | ') : ''}`)
})
