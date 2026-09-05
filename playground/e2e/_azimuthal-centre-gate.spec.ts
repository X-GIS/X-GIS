// ═══ #2061 — azimuthal_equidistant near-centre render gate ═══
//
// Six rings of point features, 400 m … 4200 m from the projection centre, are
// pushed into the offline `fixture_inline_push` source and rendered under
// `?proj=azimuthal_equidistant` at z13 (9.55 m/px). The chrome-free, quiesced
// frame (capture-canvas) is read as dot BLOBS whose distance from the frame
// centre must be the ring's radius, and the CPU twin is read through
// `map.project()` — the label path — for every ring point.
//
// Before the fix the forward derived the angular distance as acos(cos_c), which
// is 0 once cos_c rounds to 1: every dot inside 1.5 km (hardware f32) landed on
// the centre pixel, and on SwiftShader — whose transcendentals round cos_c to 1
// out to ~26 km at this latitude (MEASURED, _shader-math-parity's ladder) — the
// whole scene did: ONE blob, 36 dots deep. The CPU twin collapsed the 400 m ring
// the same way behind its explicit 637 m guard.
//
// Structure, not counts (§12), and scale-free on purpose (the zoom→metre scale
// is the flat view's contract, not this gate's): the rings whose dots are
// isolated and fully on-screen (1400 m, 2100 m) must each yield SIX blobs at the
// CPU twin's radius ±3 px; the CPU radii must be isotropic and proportional to
// the ring metres to 1 %, so the 400 m ring cannot read as the centre. The two
// inner rings' 80 px dots overlap each other (the blob pass sees one rosette)
// and the outer rings clip at the frame edge — both are left out of the blob
// half deliberately.

import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { captureMapFrame, awaitMapIdle } from './helpers/visual'

test.describe.configure({ timeout: 300_000 }) // file scope — covers fixtures (§12)

const CLON = 127
const CLAT = 37.5
const ZOOM = 13
const RINGS_M = [400, 700, 1400, 2100, 3000, 4200]
const DOTS = 6
/** Rings whose dots are isolated (no overlap with a neighbour ring's 80 px dots)
 *  and fully inside the 604×768 frame — the blob half of the gate. */
const BLOB_RINGS = [2, 3]
const R_DEG = 111320 // metres per degree of latitude (local linearisation)

type Feature = {
  type: 'Feature'
  id: number
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: { ring: number; r_m: number }
}

function ringFeatures(): Feature[] {
  const out: Feature[] = []
  let id = 1
  RINGS_M.forEach((r, k) => {
    for (let n = 0; n < DOTS; n++) {
      // Ring k is rotated 30°·k so no two rings put a dot on the same bearing.
      const b = ((30 * k + (360 / DOTS) * n) * Math.PI) / 180
      const dlat = (r * Math.cos(b)) / R_DEG
      const dlon = (r * Math.sin(b)) / (R_DEG * Math.cos((CLAT * Math.PI) / 180))
      out.push({
        type: 'Feature',
        id: id++,
        geometry: { type: 'Point', coordinates: [CLON + dlon, CLAT + dlat] },
        properties: { ring: k, r_m: r },
      })
    }
  })
  return out
}

type Win = Window & {
  __xgisReady?: boolean
  __xgisMap?: {
    setSourceData?: (id: string, fc: unknown) => void
    project?: (lngLat: [number, number]) => { x: number; y: number } | [number, number] | null
    ctx?: { rhi?: { backend?: string } }
  }
}

/** Connected components of rose-500 pixels (the fixture's `fill-rose-500`),
 *  as (size, centroid, distance from the frame centre). */
function dotBlobs(png: Buffer): Array<{ n: number; cx: number; cy: number; dist: number }> {
  const { width: w, height: h, data } = PNG.sync.read(png)
  const isDot = (i: number) =>
    data[i] > 170 && data[i + 1] < 120 && data[i + 2] > 40 && data[i + 2] < 180
  const seen = new Uint8Array(w * h)
  const blobs: Array<{ n: number; cx: number; cy: number; dist: number }> = []
  const stack: number[] = []
  for (let p = 0; p < w * h; p++) {
    if (seen[p] || !isDot(p * 4)) continue
    let n = 0
    let sx = 0
    let sy = 0
    stack.push(p)
    seen[p] = 1
    while (stack.length) {
      const q = stack.pop()!
      const x = q % w
      const y = (q - x) / w
      n++
      sx += x
      sy += y
      for (const t of [q - 1, q + 1, q - w, q + w]) {
        if (t < 0 || t >= w * h || seen[t]) continue
        if (Math.abs((t % w) - x) > 1) continue
        if (!isDot(t * 4)) continue
        seen[t] = 1
        stack.push(t)
      }
    }
    if (n >= 30)
      blobs.push({ n, cx: sx / n, cy: sy / n, dist: Math.hypot(sx / n - w / 2, sy / n - h / 2) })
  }
  return blobs.sort((a, b) => a.dist - b.dist)
}

test('azimuthal_equidistant near-centre rings land at their radius on both twins (#2061)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto(
    `/demo.html?id=fixture_inline_push&e2e=1&adaptive=0&proj=azimuthal_equidistant#${ZOOM}/${CLAT}/${CLON}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 120_000,
  })
  // Assert the backend so a silent fallback cannot green it (§5).
  const backend = await page.evaluate(
    () => (window as unknown as Win).__xgisMap?.ctx?.rhi?.backend ?? 'unknown',
  )
  expect(backend).toBe('webgpu')

  const features = ringFeatures()
  await page.evaluate(
    (fc) => {
      ;(window as unknown as Win).__xgisMap!.setSourceData!('tracks', fc)
    },
    { type: 'FeatureCollection', features },
  )
  expect(await awaitMapIdle(page, 90_000)).toBe('idle')
  const png = await captureMapFrame(page, { readyTimeoutMs: 90_000 })
  writeFileSync(test.info().outputPath('frame.png'), png)
  const { width: w, height: h } = PNG.sync.read(png)

  // ── CPU twin: map.project() for every ring point (the label path). ──
  const cpu = await page.evaluate(
    (pts: Array<[number, number]>) => {
      const m = (window as unknown as Win).__xgisMap
      if (!m?.project) return null
      return pts.map((p) => {
        const r = m.project!(p)
        if (!r) return null
        return Array.isArray(r) ? [r[0], r[1]] : [r.x, r.y]
      })
    },
    features.map((f) => f.geometry.coordinates),
  )
  expect(cpu, 'map.project() is unreachable — the CPU half of this gate cannot run').not.toBeNull()
  const cpuRadius: number[] = []
  RINGS_M.forEach((r, k) => {
    const d = features
      .map((f, i) => (f.properties.ring === k ? cpu![i] : null))
      .filter((p): p is number[] => p !== null)
      .map((p) => Math.hypot(p[0] - w / 2, p[1] - h / 2))
    expect(d, `ring ${r} m: every point must project`).toHaveLength(DOTS)
    const mean = d.reduce((a, b) => a + b, 0) / d.length
    // Azimuthal equidistant: one radius for every bearing.
    expect(
      Math.max(...d) - Math.min(...d),
      `ring ${r} m: CPU radius is not isotropic`,
    ).toBeLessThan(0.5)
    cpuRadius.push(mean)
  })
  // Radius ∝ metres (the innermost ring is what the old guard collapsed to 0).
  const pxPerM = cpuRadius[BLOB_RINGS[0]] / RINGS_M[BLOB_RINGS[0]]
  expect(
    cpuRadius[BLOB_RINGS[0]],
    'blob rings must span enough pixels for ±3 px to mean anything',
  ).toBeGreaterThan(50)
  RINGS_M.forEach((r, k) => {
    expect(
      Math.abs(cpuRadius[k] / (r * pxPerM) - 1),
      `ring ${r} m: CPU radius ${cpuRadius[k].toFixed(1)} px is not proportional to its metres`,
    ).toBeLessThan(0.01)
  })

  // ── GPU twin: six isolated dot blobs per blob ring, at the CPU radius ±3 px. ──
  const blobs = dotBlobs(png)
  const report = { backend, w, h, cpuRadius, blobs }
  writeFileSync(test.info().outputPath('rings.json'), JSON.stringify(report, null, 2))
  console.log(
    `[#2061 gate] cpu radii px: ${cpuRadius.map((v) => v.toFixed(1)).join(' / ')}; blobs: ${blobs
      .map((b) => `${b.dist.toFixed(1)}`)
      .join(' ')}`,
  )
  for (const k of BLOB_RINGS) {
    const hits = blobs.filter((b) => Math.abs(b.dist - cpuRadius[k]) <= 3)
    expect(
      hits,
      `ring ${RINGS_M[k]} m: expected ${DOTS} dots at ${cpuRadius[k].toFixed(1)} px ±3, blobs at ${blobs
        .map((b) => b.dist.toFixed(1))
        .join(' ')}`,
    ).toHaveLength(DOTS)
  }
})
