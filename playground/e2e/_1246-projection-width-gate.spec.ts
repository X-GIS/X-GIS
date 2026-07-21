// #1246 — flat-projection stroke width must be projection-invariant.
//
// A stroke authored `line-width: W` collapsed to ~W·cosφ on every NON-Mercator
// flat projection (equirectangular, natural_earth, stereographic, …): the flat
// display MVP maps projected metres → pixels at the SINGLE Mercator 1/mpp for
// ALL flat projTypes, so `finalize_corner` reprojecting the tile-local Mercator
// half-width offset shrank it by the Merc→projection Jacobian J (equirect N–S:
// J = cosφ). At the owner camera (lat 66.7°) equirect/stereographic strokes were
// ~0.4× the Mercator width. The VS clamp now measures J on-screen and widens the
// clip-space quad's across by 1/J, leaving the FS byte-unchanged.
//
// This gate measures the effective (area-per-length) stroke width on
// mercator + equirectangular + stereographic at TWO cameras:
//   • OWNER  (line_antimeridian, lat 66.7°) — the fix must be strongly ACTIVE;
//     pre-fix equirect/stereo were ~0.4× Mercator (far outside ±30%).
//   • EQUATOR (fixture_line, lat 0, cosφ≈1) — the fix must be a near-NO-OP;
//     all three projections already agree, and must STILL agree post-fix.
// Assertion: each non-Mercator width within ±30% of the same camera's Mercator
// width. Mercator is the correct reference (byte-identical, unchanged).
//
// forcegl2 + SwiftShader (XGIS_SOFTWARE_GPU=1). Chrome is hidden before readback
// so only the map canvas contributes stroke pixels.
import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '__1246-width__')

// rose-500 (line_antimeridian) — high red, red≫green, red≫blue (AA-robust).
const rose = (b: Uint8Array, i: number): boolean =>
  b[i]! > 150 && b[i]! - b[i + 1]! > 70 && b[i]! - b[i + 2]! > 40
// amber-300 (fixture_line) — high red+green, low blue.
const amber = (b: Uint8Array, i: number): boolean =>
  b[i]! > 180 && b[i + 1]! > 140 && b[i + 2]! < 120 && b[i]! - b[i + 2]! > 70

const OWNER = { demo: 'line_antimeridian', hash: '#7.15/66.69669/-179.33587', isStroke: rose }
const EQUATOR = { demo: 'fixture_line', hash: '#3/0/0', isStroke: amber }
const PROJECTIONS = ['mercator', 'equirectangular', 'stereographic'] as const

const STOPS: { id: string; base: typeof OWNER }[] = [
  { id: 'owner-lat66', base: OWNER },
  { id: 'equator-lat0', base: EQUATOR },
]

async function hideChrome(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('body > *').forEach((el) => {
      const h = el as HTMLElement
      if (!h.querySelector?.('#map') && h.id !== 'layout') h.style.visibility = 'hidden'
    })
    const keep = new Set(['map-pane', 'map', 'layout'])
    document.querySelectorAll('#map-pane > *').forEach((el) => {
      const h = el as HTMLElement
      if (!keep.has(h.id)) h.style.visibility = 'hidden'
    })
  })
}

/** TILT- AND CURVE-INVARIANT effective stroke width (px) = stroke area / TRUE
 *  centerline arc-length. The arc-length integrates the per-slice centroid
 *  polyline (Σ√(1+slope²) along the dominant axis), so it grows with both the
 *  on-screen TILT and CURVATURE the projections introduce — Mercator stretches
 *  high-latitude N–S more than equirect, and stereographic bows meridians. A
 *  plain area/bbox (ignores tilt+curve) or a PCA minor axis (mistakes curvature
 *  for thickness) both fail here; area/arclength recovers the true perpendicular
 *  thickness because area == width · arclength for a constant-width strip. The
 *  dominant axis is the longer bbox extent; centroids are per-slice means. */
async function measureWidth(
  page: import('@playwright/test').Page,
  predicate: string,
): Promise<{ width: number; area: number; arclen: number; bbox: number } | null> {
  return page.evaluate((predSrc) => {
    const isStroke = new Function('b', 'i', `return (${predSrc})`) as (
      b: Uint8Array,
      i: number,
    ) => boolean
    const w = window as unknown as {
      __xgisMap?: { ctx?: { rhi?: { gl?: WebGL2RenderingContext } } }
    }
    const gl = w.__xgisMap?.ctx?.rhi?.gl
    if (!gl) return null
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const buf = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    // Per-column (sum y, count) and per-row (sum x, count) accumulators, so we
    // can build the centroid polyline along whichever axis dominates.
    const colSy = new Float64Array(W)
    const colN = new Int32Array(W)
    const rowSx = new Float64Array(H)
    const rowN = new Int32Array(H)
    let area = 0
    let x0 = W
    let x1 = -1
    let y0 = H
    let y1 = -1
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (isStroke(buf, (y * W + x) * 4)) {
          area++
          colSy[x]! += y
          colN[x]!++
          rowSx[y]! += x
          rowN[y]!++
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
    if (area === 0) return { width: 0, area: 0, arclen: 0, bbox: 0 }
    const horizontal = x1 - x0 >= y1 - y0
    const bbox = Math.max(x1 - x0, y1 - y0)
    // Arc-length of the centroid polyline along the dominant axis.
    let arclen = 0
    let prev = NaN
    if (horizontal) {
      for (let x = x0; x <= x1; x++) {
        if (colN[x]! === 0) continue
        const c = colSy[x]! / colN[x]!
        if (!Number.isNaN(prev)) arclen += Math.hypot(1, c - prev)
        prev = c
      }
    } else {
      for (let y = y0; y <= y1; y++) {
        if (rowN[y]! === 0) continue
        const c = rowSx[y]! / rowN[y]!
        if (!Number.isNaN(prev)) arclen += Math.hypot(1, c - prev)
        prev = c
      }
    }
    return { width: arclen > 0 ? area / arclen : 0, area, arclen, bbox }
  }, predicate)
}

test('#1246 flat stroke width is projection-invariant (owner + equator)', async ({ page }) => {
  test.setTimeout(360_000)
  mkdirSync(OUT, { recursive: true })
  const failures: string[] = []
  const table: string[] = []

  for (const { id, base } of STOPS) {
    const predSrc =
      base.isStroke === rose
        ? 'b[i] > 150 && b[i]-b[i+1] > 70 && b[i]-b[i+2] > 40'
        : 'b[i] > 180 && b[i+1] > 140 && b[i+2] < 120 && b[i]-b[i+2] > 70'
    const widths: Record<string, number> = {}
    for (const proj of PROJECTIONS) {
      await page.goto(`/demo.html?id=${base.demo}&forcegl2=1&preserve=1&proj=${proj}${base.hash}`, {
        waitUntil: 'domcontentloaded',
      })
      await page.waitForFunction(
        () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
        { timeout: 30_000 },
      )
      await page.waitForTimeout(6000)
      await hideChrome(page)
      await page.waitForTimeout(300)
      const m = await measureWidth(page, predSrc)
      await page.screenshot({ path: join(OUT, `${id}-${proj}.png`) })
      if (!m || m.area < 50) {
        failures.push(`${id}/${proj}: stroke not found (area=${m?.area ?? 'null'})`)
        widths[proj] = 0
        continue
      }
      widths[proj] = m.width
      table.push(
        `${id}/${proj}: width=${m.width.toFixed(2)}px area=${m.area} arclen=${m.arclen.toFixed(
          1,
        )} bbox=${m.bbox}`,
      )
    }
    const merc = widths.mercator ?? 0
    if (merc <= 0) {
      failures.push(`${id}: mercator reference width is 0`)
      continue
    }
    for (const proj of ['equirectangular', 'stereographic'] as const) {
      const ratio = (widths[proj] ?? 0) / merc
      table.push(`${id}/${proj} ÷ mercator = ${ratio.toFixed(3)}`)
      if (Math.abs(ratio - 1) > 0.3) {
        failures.push(
          `${id}/${proj}: width ${(widths[proj] ?? 0).toFixed(2)}px is ${ratio.toFixed(
            3,
          )}× mercator (${merc.toFixed(2)}px) — outside ±30%`,
        )
      }
    }
  }

  console.log('#1246 width table:\n  ' + table.join('\n  '))
  expect(failures, failures.join('\n')).toEqual([])
})
