// Visual-regression MATRIX gate — oracle dispatch (Increment 1).
//
// One `runOracle` entry point that dispatches on OracleKind to a per-kind
// detector. Each detector REUSES the existing harness — it does not reinvent
// capture, the d3 reference, pixelmatch, or the histogram helpers:
//
//   • numeric_forward / pixel_ref  → the live MVP + the in-page d3 reference
//     (render-verify/camera-map.ts + d3-reference.ts). xgisCameraToD3 THROWS
//     for a non-flat projection; we surface that as `skipped`, never as a
//     silent pass — the runner must not invent a reference it cannot verify.
//   • ink_family   → colorHistogram (helpers/visual.ts) family buckets.
//   • disc_fraction→ in-page fill-fraction count (the synth-bg disc pattern).
//   • black_ratio  → pure-black fraction (the _coverage-black-ratio pattern).
//   • screenshot_diff → committed baseline PNG (node fs) vs pixelDiffRatio.
//     A MISSING baseline is reported `candidate-missing` (soft), never failed.
//   • label_onscreen → placed-label anchors via setLabelDebugHook, off-margin
//     count.
//
// Detector results are PLAIN DATA; the runner decides hard-fail vs soft-warn
// based on the cell's effective gate. This module imports node `fs`/`path`
// (for the baseline load) AND a Playwright Page, so it is spec-only (never
// bundled into the page).

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { captureCanvas, colorHistogram, pixelDiffRatio } from '../e2e/helpers/visual'
import type { MatrixCell, OracleSpec, InkFamilyName } from './matrix-types'

/** Directory of human-reviewed, committed baseline PNGs (matrix-accept writes
 *  here; the runner only READS). Resolved relative to this module. */
export const BASELINE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'baselines')

/** One oracle's verdict. `pass` drives hard/soft; `status` distinguishes the
 *  three non-fail "did-not-run" outcomes so the report is honest. */
export interface OracleResult {
  kind: string
  /** false ⇒ a real failure the cell's gate may act on. */
  pass: boolean
  /** 'ok' | 'skipped' (no verifiable reference) | 'candidate-missing'
   *  (baseline not yet accepted) | 'error' (oracle threw). */
  status: 'ok' | 'skipped' | 'candidate-missing' | 'error'
  /** The number the oracle measured (mismatch ratio, drift px, fraction…). */
  measured: number | null
  /** The threshold it was compared against (for the report row). */
  threshold: number | null
  /** Human-readable one-liner for the report table. */
  detail: string
}

/** Family hexes — pinned to render-verify/d3-reference.ts STYLE for the
 *  synthetic fixture, plus `slate` ≈ OFM-bright water fill (#a0c8f0-ish slate;
 *  tolerance is wide because the basemap water hue is style-resolved). */
const FAMILY_RGB: Record<InkFamilyName, [number, number, number]> = {
  emerald: [16, 185, 129],
  rose: [244, 63, 94],
  sky: [56, 189, 248],
  amber: [245, 158, 11],
  slate: [170, 211, 223],
  disc_fill: [68, 136, 204], // #4488cc — SyntheticEarthSurfaceBackend solid disc fill
}
const FAMILY_TOL: Record<InkFamilyName, number> = {
  emerald: 45,
  rose: 45,
  sky: 45,
  amber: 45,
  slate: 60,
  disc_fill: 40, // matches the synth-bg disc tolerance used by runDiscFraction
}

// ── numeric_forward / pixel_ref: build the d3 reference + compare ───────────
//
// Both depend on a VERIFIED flat d3 reference. We probe xgisCameraToD3 in-page
// first; if it throws (non-flat projection), the oracle is `skipped` — the
// runner reports it, never trusts it.

async function referenceIsAvailable(
  page: Page,
  cell: MatrixCell,
): Promise<boolean> {
  return await page.evaluate(
    async ({ proj, center, zoom }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const viteImport = (u: string): Promise<any> => import(/* @vite-ignore */ u)
      try {
        const cam = await viteImport('/render-verify/camera-map.ts')
        cam.xgisCameraToD3(proj, center, zoom, 1024, 768)
        return true
      } catch {
        return false
      }
    },
    { proj: cell.projection, center: cell.camera.center, zoom: cell.zoom },
  )
}

/** numeric_forward — max screen-px disagreement between the live GPU MVP and
 *  the CPU/d3 mirror (the probe's forward-agreement). Mirrors the Oracle-B
 *  numeric block; only flat (mercator/equirectangular/natural_earth) cells run
 *  it. Non-flat → skipped. */
async function runNumericForward(
  page: Page,
  cell: MatrixCell,
  o: OracleSpec,
): Promise<OracleResult> {
  const threshold = o.max ?? 1e-2
  if (!(await referenceIsAvailable(page, cell))) {
    return {
      kind: 'numeric_forward',
      pass: true,
      status: 'skipped',
      measured: null,
      threshold,
      detail: `no verified d3 reference for "${cell.projection}" — skipped (not trusted)`,
    }
  }
  const maxErrPx = await page.evaluate(
    async ({ proj, center, zoom }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const viteImport = (u: string): Promise<any> => import(/* @vite-ignore */ u)
      const dpr = window.devicePixelRatio || 1
      const cam = await viteImport('/render-verify/camera-map.ts')
      const m = (window as unknown as {
        __xgisMap: { getCameraDebugSnapshot(w: number, h: number, dpr: number): { matrix: number[] } }
      }).__xgisMap
      const mapBox = document.querySelector('#map')!.getBoundingClientRect()
      const Wcss = Math.round(mapBox.width)
      const Hcss = Math.round(mapBox.height)
      const snap = m.getCameraDebugSnapshot(Wcss, Hcss, dpr)
      const M = snap.matrix

      // CPU mirror of the flat project_geom feeding the shared Mercator RTC MVP
      // (identical math to the Oracle-B numeric block).
      const EARTH_R = 6378137
      const DEG2RAD = Math.PI / 180
      const LAT_CLAMP = 85.0511287798066
      const lonLatToMercator = (lon: number, lat: number): [number, number] => {
        const cl = Math.max(-LAT_CLAMP, Math.min(LAT_CLAMP, lat))
        return [lon * DEG2RAD * EARTH_R, Math.log(Math.tan(Math.PI / 4 + (cl * DEG2RAD) / 2)) * EARTH_R]
      }
      const wrapLonDelta = (d: number): number => {
        if (d > 180) return d - Math.ceil((d - 180) / 360) * 360
        if (d < -180) return d + Math.ceil((-d - 180) / 360) * 360
        return d
      }
      const projEquirectD = (lonRel: number, lat: number): [number, number] => [
        lonRel * DEG2RAD * EARTH_R,
        lat * DEG2RAD * EARTH_R,
      ]
      const projNaturalEarthD = (lonRel: number, lat: number): [number, number] => {
        const phi = lat * DEG2RAD
        const phi2 = phi * phi, phi4 = phi2 * phi2, phi6 = phi2 * phi4
        const xScale = 0.8707 - 0.131979 * phi2 + 0.013791 * phi4 - 0.0081435 * phi6
        const yVal = phi * (1.007226 + phi2 * (0.015085 + phi2 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4)))
        return [lonRel * DEG2RAD * xScale * EARTH_R, yVal * EARTH_R]
      }
      const clon = center[0], clat = center[1]
      const projGeom = (lon: number, lat: number): [number, number] => {
        if (proj === 'mercator') return lonLatToMercator(lon, lat)
        const lonRel = wrapLonDelta(lon - clon)
        return proj === 'natural_earth' ? projNaturalEarthD(lonRel, lat) : projEquirectD(lonRel, lat)
      }
      const projCenter = (): [number, number] => {
        if (proj === 'mercator') return lonLatToMercator(clon, clat)
        return proj === 'natural_earth' ? projNaturalEarthD(0, clat) : projEquirectD(0, clat)
      }
      const [cMX, cMY] = projCenter()
      const xgisScreen = (lon: number, lat: number): [number, number] => {
        const [mx, my] = projGeom(lon, lat)
        const rx = mx - cMX, ry = my - cMY
        const cx = M[0] * rx + M[4] * ry + M[12]
        const cy = M[1] * rx + M[5] * ry + M[13]
        const cw = M[3] * rx + M[7] * ry + M[15]
        return [((cx / cw) + 1) / 2 * Wcss, (1 - (cy / cw)) / 2 * Hcss]
      }
      const projection = cam.xgisCameraToD3(proj, center, zoom, Wcss, Hcss)
      const lons = [-40, -20, 0, 20, 40].map((d) => center[0] + d)
      const lats = [-20, -10, 0, 10, 20].map((d) => center[1] + d)
      const worldW = 512 * Math.pow(2, zoom)
      let maxErr = 0
      let sawNonFinite = false
      for (const lon of lons) for (const lat of lats) {
        const [sx, sy] = xgisScreen(lon, lat)
        const d3 = projection([lon, lat]) as [number, number] | null
        if (!d3) continue
        let dx = sx - d3[0]
        dx -= Math.round(dx / worldW) * worldW
        const e = Math.hypot(dx, sy - d3[1])
        if (!Number.isFinite(e)) { sawNonFinite = true; continue }
        if (e > maxErr) maxErr = e
      }
      return sawNonFinite ? NaN : maxErr
    },
    { proj: cell.projection, center: cell.camera.center, zoom: cell.zoom },
  )
  const finite = Number.isFinite(maxErrPx)
  return {
    kind: 'numeric_forward',
    pass: finite && maxErrPx < threshold,
    status: 'ok',
    measured: maxErrPx,
    threshold,
    detail: finite
      ? `maxErr ${maxErrPx.toExponential(2)}px (≤${threshold})`
      : `NON-FINITE MVP (NaN/Inf) — corrupted camera/projection uniform`,
  }
}

/** pixel_ref — pixelmatch(GPU frame, in-page d3 Canvas2D reference) mismatch
 *  ratio. Flat projections only (skipped otherwise). Mirrors Oracle-B steps
 *  b+c: build the reference at the map's pixel grid with a matching opaque
 *  background, then diff. */
async function runPixelRef(
  page: Page,
  cell: MatrixCell,
  o: OracleSpec,
  png: Buffer,
): Promise<OracleResult> {
  const threshold = o.max ?? 0.06
  if (!(await referenceIsAvailable(page, cell))) {
    return {
      kind: 'pixel_ref',
      pass: true,
      status: 'skipped',
      measured: null,
      threshold,
      detail: `no verified d3 reference for "${cell.projection}" — skipped (not trusted)`,
    }
  }
  const ratio = await page.evaluate(
    async ({ b64, proj, center, zoom }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const viteImport = (u: string): Promise<any> => import(/* @vite-ignore */ u)
      // Decode the GPU frame + read its true pixel dims and background colour.
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
      const bmp = await createImageBitmap(blob)
      const W = bmp.width, H = bmp.height
      const gc = document.createElement('canvas')
      gc.width = W; gc.height = H
      const gx = gc.getContext('2d')!
      gx.drawImage(bmp, 0, 0)
      const gData = gx.getImageData(0, 0, W, H).data
      const bgp = gx.getImageData(2, 2, 1, 1).data
      const bg: [number, number, number, number] = [bgp[0], bgp[1], bgp[2], bgp[3]]

      const mapBox = document.querySelector('#map')!.getBoundingClientRect()
      const Wcss = Math.round(mapBox.width)
      const Hcss = Math.round(mapBox.height)

      // Build the d3 reference at the GPU pixel grid, opaque bg matched.
      const cam = await viteImport('/render-verify/camera-map.ts')
      const ref = await viteImport('/render-verify/d3-reference.ts')
      const fx = await viteImport('/render-verify/fixtures.ts')
      const rc = document.createElement('canvas')
      rc.width = W; rc.height = H
      const rx = rc.getContext('2d')!
      rx.fillStyle = `rgba(${bg[0]},${bg[1]},${bg[2]},${bg[3] / 255})`
      rx.fillRect(0, 0, W, H)
      rx.scale(W / Wcss, H / Hcss)
      const projection = cam.xgisCameraToD3(proj, center, zoom, Wcss, Hcss)
      ref.renderReferenceToCanvas(rx, {
        graticule: fx.GRATICULE, polys: fx.POLYS, lines: fx.LINES, points: fx.POINTS,
      }, projection)
      const rData = rx.getImageData(0, 0, W, H).data

      const pm = (await viteImport('/render-verify/pixelmatch-browser.ts')).pixelmatch as (
        a: Uint8ClampedArray, b: Uint8ClampedArray, out: Uint8ClampedArray | null,
        w: number, h: number, opts?: { threshold?: number },
      ) => number
      const mismatched = pm(gData, rData, null, W, H, { threshold: 0.1 })
      return mismatched / (W * H)
    },
    { b64: png.toString('base64'), proj: cell.projection, center: cell.camera.center, zoom: cell.zoom },
  )
  return {
    kind: 'pixel_ref',
    pass: ratio < threshold,
    status: 'ok',
    measured: ratio,
    threshold,
    detail: `mismatch ${(ratio * 100).toFixed(3)}% (≤${(threshold * 100).toFixed(1)}%)`,
  }
}

/** ink_family — every required family must clear its min pixel ratio. Uses the
 *  shared colorHistogram helper. A dropped thin/sparse layer (which the pixel
 *  oracle is blind to) fails here. */
async function runInkFamily(
  page: Page,
  o: OracleSpec,
  png: Buffer,
): Promise<OracleResult> {
  const families = o.families ?? []
  const buckets = families.map((f) => ({
    name: f.name,
    rgb: FAMILY_RGB[f.name],
    tolerance: FAMILY_TOL[f.name],
  }))
  const ratios = await colorHistogram(page, png, buckets)
  const fails: string[] = []
  let minMeasured = 1
  for (const f of families) {
    const r = ratios[f.name] ?? 0
    if (r < minMeasured) minMeasured = r
    if (r < f.minRatio) {
      fails.push(`${f.name} ${(r * 100).toFixed(3)}%<${(f.minRatio * 100).toFixed(3)}%`)
    }
  }
  return {
    kind: 'ink_family',
    pass: fails.length === 0,
    status: 'ok',
    measured: minMeasured,
    threshold: Math.min(...families.map((f) => f.minRatio), 1),
    detail: fails.length === 0
      ? `all families inked (${families.map((f) => `${f.name}=${((ratios[f.name] ?? 0) * 100).toFixed(2)}%`).join(', ')})`
      : `NO ink: ${fails.join(', ')}`,
  }
}

/** disc_fraction — fraction of canvas covered by the synthetic disc fill
 *  (#4488cc). Compared to `expected ± max`. A presence/framing tripwire. */
async function runDiscFraction(
  page: Page,
  o: OracleSpec,
  png: Buffer,
): Promise<OracleResult> {
  const expected = o.expected ?? 0.45
  const tol = o.max ?? 0.25
  const fraction = await page.evaluate(
    async (b64: string) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width; c.height = bmp.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
      // Fill #4488cc = (68,136,204), tol 40 (matches the synth-bg spec).
      const FR = 68, FG = 136, FB = 204, T = 40
      let fill = 0
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - FR) <= T && Math.abs(d[i + 1] - FG) <= T && Math.abs(d[i + 2] - FB) <= T) fill++
      }
      return fill / (bmp.width * bmp.height)
    },
    png.toString('base64'),
  )
  const drift = Math.abs(fraction - expected)
  return {
    kind: 'disc_fraction',
    pass: drift <= tol,
    status: 'ok',
    measured: fraction,
    threshold: tol,
    detail: `disc fill ${(fraction * 100).toFixed(1)}% (expected ${(expected * 100).toFixed(0)}% ±${(tol * 100).toFixed(0)}%)`,
  }
}

/** black_ratio — fraction of PURE-black pixels. Every pixel must have a
 *  defined source (sky, basemap, fill); a black void above the horizon at
 *  high pitch, or an undrawn region, is the failure this catches. */
async function runBlackRatio(
  page: Page,
  o: OracleSpec,
  png: Buffer,
): Promise<OracleResult> {
  const threshold = o.max ?? 0.02
  const ratio = await page.evaluate(
    async (b64: string) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width; c.height = bmp.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
      let black = 0
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] <= 4 && d[i + 1] <= 4 && d[i + 2] <= 4) black++
      }
      return black / (bmp.width * bmp.height)
    },
    png.toString('base64'),
  )
  return {
    kind: 'black_ratio',
    pass: ratio <= threshold,
    status: 'ok',
    measured: ratio,
    threshold,
    detail: `pure-black ${(ratio * 100).toFixed(3)}% (≤${(threshold * 100).toFixed(1)}%)`,
  }
}

/** screenshot_diff — diff the GPU frame against the committed, human-reviewed
 *  baseline PNG. If no baseline exists, report `candidate-missing` (soft) —
 *  this is the load-bearing rule: a missing baseline NEVER fails the run. */
async function runScreenshotDiff(
  page: Page,
  cell: MatrixCell,
  o: OracleSpec,
  png: Buffer,
): Promise<OracleResult> {
  const threshold = o.max ?? 0.03
  const baselinePath = join(BASELINE_DIR, `${cell.id}.png`)
  if (!existsSync(baselinePath)) {
    return {
      kind: 'screenshot_diff',
      pass: true,
      status: 'candidate-missing',
      measured: null,
      threshold,
      detail: `no committed baseline for "${cell.id}" — candidate written, review then \`bun run matrix:accept ${cell.id}\``,
    }
  }
  const baseline = readFileSync(baselinePath)
  const ratio = await pixelDiffRatio(page, png, baseline, 12)
  return {
    kind: 'screenshot_diff',
    pass: ratio <= threshold,
    status: 'ok',
    measured: ratio,
    threshold,
    detail: `baseline diff ${(ratio * 100).toFixed(3)}% (≤${(threshold * 100).toFixed(1)}%)`,
  }
}

/** label_onscreen — count placed label anchors landing OUTSIDE the
 *  viewport+margin. Requires the runner to have installed setLabelDebugHook
 *  BEFORE positioning the camera and to read the captured anchors here. The
 *  margin (400 CSS px) tolerates labels whose anchor is just off-frame but
 *  whose glyphs still partly show; a gross mis-dispatch (projection-blind
 *  layer placing anchors a world away) blows past `max`. */
async function runLabelOnscreen(
  page: Page,
  o: OracleSpec,
): Promise<OracleResult> {
  const maxOff = o.max ?? 3
  const MARGIN = 400
  const { offCount, total } = await page.evaluate((margin) => {
    const w = window as unknown as {
      __xgisMatrixLabelAnchors?: { ax: number; ay: number }[]
    }
    const dpr = window.devicePixelRatio || 1
    const mapBox = document.querySelector('#map')!.getBoundingClientRect()
    const Wcss = mapBox.width, Hcss = mapBox.height
    const anchors = w.__xgisMatrixLabelAnchors ?? []
    let off = 0
    for (const a of anchors) {
      // The hook reports DEVICE-px anchors (the demo-runner overlay divides by
      // dpr); convert to CSS px to compare with the CSS viewport box.
      const cx = a.ax / dpr
      const cy = a.ay / dpr
      if (cx < -margin || cx > Wcss + margin || cy < -margin || cy > Hcss + margin) off++
    }
    return { offCount: off, total: anchors.length }
  }, MARGIN)
  // No anchors at all is itself suspect for a label-heavy cell, but we keep
  // this oracle focused on mis-PLACEMENT; presence is a separate concern.
  return {
    kind: 'label_onscreen',
    pass: offCount <= maxOff,
    status: 'ok',
    measured: offCount,
    threshold: maxOff,
    detail: `${offCount}/${total} anchors off the ${MARGIN}px-margin viewport (≤${maxOff})`,
  }
}

/** finite_mvp — assert every element of the live camera MVP matrix
 *  (getCameraDebugSnapshot().matrix) is finite (no NaN/Inf). A NaN/Inf in the
 *  projection uniform is the root of disc/globe coord-readout corruption and a
 *  silent render collapse. Projection-AGNOSTIC and BASELINE-FREE: it works for
 *  every projection (including the non-flat ones numeric_forward skips) and
 *  stores nothing — it is the no-baseline finiteness guard for oblique/disc/
 *  globe cells where xgisCameraToD3 throws. */
async function runFiniteMvp(page: Page): Promise<OracleResult> {
  const result = await page.evaluate(() => {
    const m = (window as unknown as {
      __xgisMap: { getCameraDebugSnapshot(w: number, h: number, dpr: number): { matrix: number[] } }
    }).__xgisMap
    const mapBox = document.querySelector('#map')!.getBoundingClientRect()
    const W = Math.round(mapBox.width)
    const H = Math.round(mapBox.height)
    const dpr = window.devicePixelRatio || 1
    const snap = m.getCameraDebugSnapshot(W, H, dpr)
    const bad = snap.matrix.filter((v) => !Number.isFinite(v)).length
    return { badCount: bad, total: snap.matrix.length }
  })
  return {
    kind: 'finite_mvp',
    pass: result.badCount === 0,
    status: 'ok',
    measured: result.badCount,
    threshold: 0,
    detail: result.badCount === 0
      ? `all ${result.total} MVP floats finite`
      : `${result.badCount}/${result.total} non-finite entries (NaN or Inf) in camera MVP`,
  }
}

/** frame_stability — deterministic-render guard. Re-captures a SECOND frame of
 *  the same settled static scene and diffs it against the first (the png the
 *  runner already captured). On the current renderer consecutive frames are
 *  pixel-identical, so the ratio is ~0; a future invalidation/skip bug that
 *  corrupts a reused static frame makes N+1 differ and fails. Uses a tiny
 *  tolerance to absorb GPU sub-pixel non-determinism / any settle jitter.
 *
 *  Capture alignment: the runner's first png is taken via `captureCanvas(page)`
 *  with no `elapsedMsAtLeast` (purely the `hasPendingSourceWork()` idle gate +
 *  2 rAF ticks). The re-capture here uses the same call form so both frames
 *  are at comparably-settled clock — no animation-elapsed offset is added,
 *  which is correct for the static `synthetic_disc` cells this oracle targets. */
async function runFrameStability(
  page: Page,
  png: Buffer,
  o: OracleSpec,
): Promise<OracleResult> {
  const threshold = o.max ?? 0.005
  // Re-capture frame N+1 of the same static scene using the same settle
  // semantics as the runner's first capture (hasPendingSourceWork idle + 2 rAF).
  const png2 = await captureCanvas(page)
  const ratio = await pixelDiffRatio(page, png, png2, 12)
  return {
    kind: 'frame_stability',
    pass: ratio <= threshold,
    status: 'ok',
    measured: ratio,
    threshold,
    detail: `frame N vs N+1 diff ${(ratio * 100).toFixed(4)}% (≤${(threshold * 100).toFixed(2)}%)`,
  }
}

/** post_change — under-invalidation guard, the COMPLEMENT of frame_stability.
 *  frame_stability proves a STATIC scene's reused frame stays correct (N+1 == N);
 *  post_change proves a CHANGED scene actually REPAINTS (N' ≠ N). It applies a
 *  reversible, guaranteed-visible camera mutation (zoom +1 — on a flat content
 *  cell this scales the geometry across the whole frame), re-captures, and
 *  asserts the frame MOVED by at least `min`, then RESTORES the cell's exact
 *  camera so any later oracle (and the trailing re-capture) observes the
 *  original, byte-identical frame — safe because the renderer is frame-
 *  deterministic (proven by frame_stability). The manifest also lists it LAST so
 *  the mutate→restore window never overlaps a sibling oracle.
 *
 *  Mutation choice: zoom (NOT pan/bearing). The synthetic_disc cells frame_
 *  stability uses are a featureless sphere whose silhouette doesn't move under
 *  pan/bearing and whose ortho zoom is 2R-cap-bound — so this oracle lives on a
 *  flat content cell (merc-europe), where zoom is uncapped and content visibly
 *  moves.
 *
 *  Inert today: the live renderer always repaints on a camera change, so this
 *  passes with a wide margin. It becomes the S16 net — a consumer skip that
 *  UNDER-invalidates (wrongly skips a needed repaint) leaves the frame stale,
 *  N' == N, and trips here. */
async function runPostChange(
  page: Page,
  png: Buffer,
  cell: MatrixCell,
  o: OracleSpec,
): Promise<OracleResult> {
  const min = o.min ?? 0.005
  // Apply a reversible, guaranteed-visible mutation: zoom +1 (uncapped on flat
  // projections; ~doubles the on-screen scale, walking the full-frame graticule
  // + content to new positions). The achievable diff is capped by content
  // density (a sparse synthetic scene is mostly uniform background), so +1's
  // ~1.3% is the cap, not a floor — a bigger jump pushes content off-frame and
  // measures LESS. min sits well below it (see manifest).
  const ZOOM_DELTA = 1
  await page.evaluate((z) => {
    const m = (window as unknown as {
      __xgisMap: { jumpTo(o: { zoom?: number }): void; invalidate?(): void }
    }).__xgisMap
    m.jumpTo({ zoom: z })
    m.invalidate?.()
  }, cell.zoom + ZOOM_DELTA)
  const pngChanged = await captureCanvas(page)
  const ratio = await pixelDiffRatio(page, png, pngChanged, 12)
  // Restore the cell's EXACT camera so downstream oracles / re-captures observe
  // the original frame (deterministic renderer ⇒ byte-identical to `png`).
  await page.evaluate(({ center, zoom, pitch, bearing }) => {
    const m = (window as unknown as {
      __xgisMap: {
        jumpTo(o: { center?: [number, number]; zoom?: number; pitch?: number; bearing?: number }): void
        markCameraPositioned(): void
        invalidate?(): void
      }
    }).__xgisMap
    m.jumpTo({ center, zoom, pitch, bearing })
    m.markCameraPositioned()
    m.invalidate?.()
  }, { center: cell.camera.center, zoom: cell.zoom, pitch: cell.pitch, bearing: cell.bearing })
  await captureCanvas(page) // re-settle the restored frame before returning
  return {
    kind: 'post_change',
    pass: ratio >= min,
    status: 'ok',
    measured: ratio,
    threshold: min,
    detail: `post-change frame moved ${(ratio * 100).toFixed(3)}% on zoom ${cell.zoom}→${cell.zoom + ZOOM_DELTA} (≥${(min * 100).toFixed(2)}% required)`,
  }
}

/** Dispatch one oracle. The runner calls this per (cell, oracle) and records
 *  the result; it never throws on a detector failure — it returns a result. */
export async function runOracle(
  page: Page,
  png: Buffer,
  cell: MatrixCell,
  o: OracleSpec,
): Promise<OracleResult> {
  try {
    switch (o.kind) {
      case 'numeric_forward': return await runNumericForward(page, cell, o)
      case 'pixel_ref': return await runPixelRef(page, cell, o, png)
      case 'ink_family': return await runInkFamily(page, o, png)
      case 'disc_fraction': return await runDiscFraction(page, o, png)
      case 'black_ratio': return await runBlackRatio(page, o, png)
      case 'screenshot_diff': return await runScreenshotDiff(page, cell, o, png)
      case 'label_onscreen': return await runLabelOnscreen(page, o)
      case 'finite_mvp': return await runFiniteMvp(page)
      case 'frame_stability': return await runFrameStability(page, png, o)
      case 'post_change': return await runPostChange(page, png, cell, o)
      default:
        return {
          kind: String(o.kind),
          pass: true,
          status: 'skipped',
          measured: null,
          threshold: null,
          detail: `unknown oracle kind "${o.kind}" — skipped`,
        }
    }
  } catch (err) {
    // An oracle that THROWS is reported as an error result (the runner decides
    // hard/soft) — it must not crash the whole matrix loop.
    return {
      kind: String(o.kind),
      pass: false,
      status: 'error',
      measured: null,
      threshold: o.max ?? o.min ?? null,
      detail: `oracle threw: ${(err as Error).message ?? String(err)}`,
    }
  }
}
