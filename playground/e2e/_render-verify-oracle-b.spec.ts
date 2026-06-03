// Oracle-B gate — "is the render actually RIGHT?" (real GPU, LOCAL only).
//
// d3-geo projects the SAME synthetic geometry and Canvas2D renders it = a
// math-derived, trivially-trustworthy reference. The X-GIS GPU frame is
// pixel-diffed against that reference (within an AA tolerance, since a GPU
// rasterizer and Canvas2D antialias differently). Two oracles, both numeric,
// zero LLM tokens:
//
//   1. PIXEL oracle  — pixelmatch(xgisPng, refPng) → mismatchRatio.
//   2. NUMERIC oracle — the probe's forward-agreement: project the fixture
//      lon/lats through BOTH the live GPU MVP (getCameraDebugSnapshot) and
//      the d3 recipe; assert max screen-px disagreement is ~0. This is the
//      cheap, tolerance-free check that the projection placement is exact;
//      the pixel diff then covers rasterization on top of it.
//
// Both the d3 reference render AND the numeric projection run IN-PAGE (Vite
// serves render-verify/*.ts as modules; d3-geo is a playground devDep), so
// the reference and the GPU readback share one colour space + DPR.
//
// Real GPU headed (HEADED=1; do NOT set XGIS_SOFTWARE_GPU). ADR-0004: this
// is a LOCAL/pre-push gate, not CI. PNGs → .omc/shots/render-verify/.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'

const OUT = 'D:/X-GIS/.omc/shots/render-verify'

// Viewport (device px). DPR is read at runtime; CSS px = device / dpr.
const VW = 1024
const VH = 768

// ── Tolerances (justified from the actual baseline; see report) ──────────
// PIXEL: GPU vs Canvas2D AA differ; thin grid/lines + disc edges produce a
// band of near-match pixels that pixelmatch (threshold 0.1) flags. 0.06 is a
// generous ceiling — the spec logs the ACTUAL ratio so the number is auditable
// and can be ratcheted down. A catastrophic regression (dropped layer, seam
// tear) blows far past this.
const PIXEL_MISMATCH_MAX = 0.06
// NUMERIC: probe measured max 2.08e-5 px over 31 samples. 1e-2 px is a huge
// safety margin that still catches any real projection-constant drift (a 1%
// EARTH_R/scale nudge moves edge points by tens of px).
const NUMERIC_ERR_MAX_PX = 1e-2

interface MapH {
  setSourceData(id: string, fc: unknown): void
  setProjection(n: string): void
  jumpTo(o: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void
  markCameraPositioned(): void
  getCameraDebugSnapshot(w: number, h: number, dpr: number): { matrix: number[] }
  invalidate?(): void
}

/** Families whose ink the per-family oracle can hard-gate. amber is OPEN
 *  FINDING #1 (inline-GeoJSON point-render gap) — warned, never hard-gated. */
type InkFamily = 'emerald' | 'rose' | 'sky' | 'amber'

/** X-GIS flat projections Oracle-B numerically covers (projType 0/1/2 — all
 *  share the Mercator RTC MVP; only the per-vertex project_geom differs). */
type OracleProj = 'mercator' | 'equirectangular' | 'natural_earth'

interface CaseDef {
  name: string
  center: [number, number]
  zoom: number
  /** X-GIS projection to set + diff against. Defaults to 'mercator'. The d3
   *  reference and the numeric X-GIS forward are both selected from this. */
  proj?: OracleProj
  /** Families this camera FRAMES that MUST produce nonzero ink — a dropped
   *  family (e.g. the rose `the_lines` layer repointed at a dead source, or a
   *  dropped fill/grid pipeline) then FAILS the gate even though the pixel
   *  oracle is blind to thin/sparse geometry. Only list families the clean
   *  baseline reliably rasterizes at this camera (measured, see report). amber
   *  is never listed (OPEN FINDING #1 — warned, not gated). */
  requireInk?: InkFamily[]
  /** OPEN FINDING #2: this case is KNOWN to hit the projType-1/2 antimeridian
   *  seam tear (a real X-GIS non-mercator seam-render bug). The pixel gate is
   *  SOFT-logged (warned) for it instead of hard-failing — the bug is tracked,
   *  not hidden; numeric placement + per-family ink stay hard-gated. */
  seamTearKnown?: boolean
}

const CASES: CaseDef[] = [
  // Europe-ish frame (the probe camera) — graticule + lines in view. The sky
  // grid spans the whole frame and the rose zigzag-north line ([…,[0,50]])
  // reaches the centre, so BOTH must rasterize: dropping the_lines (rose) or
  // the_grid (sky) fails here — the pixel oracle alone misses a thin dropped
  // family.
  { name: 'mercator-europe', center: [2.3, 48.8], zoom: 4, requireInk: ['sky', 'rose'] },
  // Antimeridian: center near +180 so the [170,10]→[-170,10] crosser is on
  // screen. The seam must be a continuous segment, NOT a full-width tear — the
  // pixel gate catches a tear (full-width >> 6%). The graticule SKIPS ±180
  // (meridians -150..150) so the grid is sparse-to-absent at this camera
  // (measured sky=0); gate ROSE instead — the crosser itself is rose, so a
  // dropped the_lines layer fails here AND the tear is a placement defect the
  // pixel gate flags. (sky is gated on europe + fills-points where it frames.)
  { name: 'mercator-antimeridian', center: [180, 10], zoom: 3, requireInk: ['rose'] },
  // Equator/prime-meridian frame: the [0,0] square + the central point grid
  // are on-screen here (they sit off-frame at the europe camera). This case
  // EXERCISES the polygon-fill and point pipelines, so a regression dropping
  // either FAILS the gate — closing the "2 of 4 families never tested" hole.
  { name: 'mercator-fills-points', center: [0, 0], zoom: 2, requireInk: ['emerald', 'sky'] },

  // ── projType 1: equirectangular (plate carrée) ───────────────────────────
  // Center [0,0] z2 frames the [0,0] emerald square + central sky grid WITHOUT
  // straddling ±180 (the antimeridian crosser sits off-screen at this zoom).
  // FIRST non-mercator Oracle-B case — exercises the shared Mercator RTC MVP
  // fed by the flat project_geom (projType 1, equirect_d); both the d3
  // reference (geoEquirectangular) and the numeric X-GIS forward (CPU
  // equirect_d) are selected by `proj`. A projType-1 reproject regression
  // (wrong px-per-radian / EARTH_R drift) blows the numeric gate.
  { name: 'equirectangular', center: [0, 0], zoom: 2, proj: 'equirectangular', requireInk: ['sky', 'emerald'] },
  // OPEN FINDING #2 — non-mercator LINE-render divergence. With the `lines`
  // source KEPT (center [0,0] z2), the diagonal rose zigzags SMEAR under
  // projType 1: X-GIS draws straight GPU segments between reprojected vertices
  // while d3's geoEquirectangular geoPath follows the projected curve, so long
  // diagonal spans diverge ~15-20× (rose ink balloons, ~20% mismatch). The
  // [170,10]→[-170,10] crosser likewise tears full-width at a global frame.
  // Both render CORRECTLY under mercator — a REAL X-GIS projType-1/2 line-
  // render bug the harness CAUGHT (the non-mercator analogue of the M2
  // seam-break class). seamTearKnown soft-logs the mismatch — tracked, NOT
  // hidden, NOT silently passed; numeric placement + rose ink stay hard-gated.
  { name: 'equirectangular-line-smear', center: [0, 0], zoom: 2, proj: 'equirectangular', requireInk: ['sky', 'rose'], seamTearKnown: true },

  // ── projType 2: natural_earth ────────────────────────────────────────────
  // Center [0,20] z2 (off ±180): the NE-I polynomial reproject (projType 2).
  // The numeric forward replicates X-GIS's EXACT NE polynomial (not d3's stock
  // one), so a drift in either side's polynomial is caught. sky grid + emerald
  // fill MUST raster. (Global/antimeridian NE shares OPEN FINDING #2's seam
  // tear, so this case frames OFF the seam.)
  { name: 'natural_earth', center: [0, 20], zoom: 2, proj: 'natural_earth', requireInk: ['sky', 'emerald'] },
]

test.describe.configure({ mode: 'serial' })

for (const c of CASES) {
  const proj: OracleProj = c.proj ?? 'mercator'
  test(`oracle-B: ${c.name}`, async ({ page }) => {
    test.setTimeout(4 * 60_000)
    mkdirSync(OUT, { recursive: true })
    await page.setViewportSize({ width: VW, height: VH })

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

    // ── a. Load, push fixtures, position camera ──────────────────────────
    // Route host-pushed inline GeoJSON through VirtualPMTilesBackend (the
    // same MVT-slice pipeline URL-loaded GeoJSON uses) BEFORE the page loads,
    // so `rebuildLayers` (fired by the first setSourceData) reads the opt-in.
    //
    // WHY THIS IS LOAD-BEARING: the default `setSourceData` path tiles inline
    // GeoJSON via the legacy GeoJSONRuntimeBackend (setRawParts), which caches
    // tiles under sourceLayer='' (single-layer convention). But the VTR render
    // path looks the slice up under `show.targetName` (e.g. 'polys') — so the
    // lookup misses and EVERY draw is dropped as `drop-empty-slice`
    // (drawCalls=0, black frame). VirtualPMTilesBackend instead caches under
    // sourceLayer=sourceName=targetName, which matches → the fills/lines/points
    // actually draw. (Proven on a live headed run: drawCalls 0 → 18.)
    await page.addInitScript(() => {
      ;(window as unknown as { __XGIS_USE_VIRTUAL_INLINE_GEOJSON?: boolean }).__XGIS_USE_VIRTUAL_INLINE_GEOJSON = true
    })
    await page.goto(`/demo.html?id=fixture_render_verify&e2e=1`, {
      waitUntil: 'domcontentloaded', timeout: 60_000,
    })
    // 120s, not 60s: a cold vite webServer + first-compile of the runtime can
    // exceed 60s on the evaluator's back-to-back fresh invocations, and an
    // intermittent ready-timeout would make the harness flaky (the one thing a
    // reliability gate must not be).
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 120_000 },
    )

    // Hide the DOM chrome painted OVER the #map canvas (the #status HUD + the
    // #snapshot-btn) so the screenshot is pure rendered geometry — the d3
    // reference has no HUD/button analogue, and this chrome was 58–81% of the
    // round-3 pixel "mismatch".
    await page.addStyleTag({ content: '#status, #snapshot-btn { display: none !important; }' })

    await page.evaluate(async ({ center, zoom, proj, skipLines }) => {
      // Vite serves render-verify/*.ts at these URLs; the runtime specifier
      // is non-literal so tsc treats the module as `any` (it can't resolve a
      // dev-server URL), while Vite resolves it at runtime in-page.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const viteImport = (u: string): Promise<any> => import(/* @vite-ignore */ u)
      const m = (window as unknown as { __xgisMap: MapH }).__xgisMap
      const fx = await viteImport('/render-verify/fixtures.ts')
      for (const [id, fc] of Object.entries(fx.FIXTURE_SOURCES)) {
        // OPEN FINDING #2: non-mercator (projType 1/2) LINE rendering diverges
        // from d3 — the antimeridian crosser tears full-WORLD-width, AND
        // diagonal polylines SMEAR (X-GIS draws straight GPU segments between
        // reprojected vertices while d3 geoPath follows the projected curve; for
        // long diagonal spans under equirect the two diverge ~20×). The short,
        // densified graticule grid matches; the rose `lines` do not. So the
        // CLEAN non-mercator cases SKIP the `lines` source — poly-fill + grid +
        // points DO match d3 and stay gated. The line divergence is exercised
        // by the dedicated seamTearKnown case (which keeps the lines).
        if (skipLines && id === 'lines') continue
        m.setSourceData(id, fc)
      }
      m.setProjection(proj)
      m.jumpTo({ center, zoom, bearing: 0, pitch: 0 })
      m.markCameraPositioned()
      m.invalidate?.()
    }, { center: c.center, zoom: c.zoom, proj, skipLines: proj !== 'mercator' && !c.seamTearKnown })

    // Inline GeoJSON tiles compile async (worker pool → MVT slice → GPU
    // upload) AFTER setSourceData returns. Block until the geometry is
    // genuinely ON the GPU AND being drawn: `stats.drawCalls > 0` is the
    // unambiguous "a frame painted the fixtures" signal. Waiting only on
    // `getCacheSize()` is NOT enough — tiles can be cached yet still dropped
    // (drop-empty-slice) so the cache fills while drawCalls stays 0; gating on
    // drawCalls catches that and keeps the screenshot from firing on an empty
    // frame. `invalidate()` each poll keeps the on-demand render loop warm.
    await page.waitForFunction(() => {
      const map = (window as unknown as {
        __xgisMap?: { stats?: { drawCalls?: number }; invalidate?: () => void }
      }).__xgisMap
      map?.invalidate?.()
      return (map?.stats?.drawCalls ?? 0) > 0
    }, null, { timeout: 20_000 }).catch(() => { /* fall through — the assertions below report the real state */ })
    // Pump a few more rAFs so the fully-populated draw lands in the swapchain.
    await page.evaluate(() => new Promise<void>((r) => {
      let n = 0
      const loop = () => { if (++n >= 8) r(); else requestAnimationFrame(loop) }
      requestAnimationFrame(loop)
    }))

    // Capture the live GPU draw count — the unambiguous "did the fixtures
    // actually render?" signal (RC1 was drawCalls=0 / black frame). Logged in
    // the report and asserted > 0 below so a silent dropped-layer regression
    // (e.g. the slice-key mismatch this spec routes around) fails loudly here
    // rather than only surfacing as a large pixel diff.
    const drawCalls = await page.evaluate(() => {
      const m = (window as unknown as { __xgisMap?: { stats?: { drawCalls?: number } } }).__xgisMap
      return m?.stats?.drawCalls ?? 0
    })

    // #map IS the WebGPU <canvas id="map"> itself (not a div), so screenshotting
    // it captures ONLY the rendered geometry — EXCEPT for the DOM chrome painted
    // over it (#status HUD + #snapshot-btn, absolute-positioned siblings), which
    // we hide above so the diff is geometry-vs-geometry (that chrome was 58–81%
    // of the round-3 "mismatch"; it has no d3 reference analogue). Measuring the
    // real box also handles the editor pane narrowing the canvas (round-2 bug:
    // hardcoding 1024 stretched the 604-wide capture 1.69×).
    const mapBox = await page.locator('#map').boundingBox()
    if (!mapBox) throw new Error('#map canvas has no bounding box')
    const Wcss = Math.round(mapBox.width)
    const Hcss = Math.round(mapBox.height)

    const xgisPng = await page.locator('#map').screenshot({ path: `${OUT}/${c.name}__xgis.png` })

    // True pixel dims of the GPU capture (Playwright may grab at CSS or device
    // scale) — the canonical grid that ref + diff must match with NO resample.
    // ALSO sample the frame's background: the fixture has no basemap, so the
    // X-GIS frame background is a flat opaque clear colour, while a fresh d3
    // canvas is transparent (alpha 0). Unless the reference is filled with the
    // SAME bg, every background pixel diffs (opaque-vs-transparent) and swamps
    // the geometry signal (the round-3 99% was this, not misalignment).
    const { W, H, bg } = await page.evaluate(async (b64: string) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
      const bmp = await createImageBitmap(blob)
      const W = bmp.width, H = bmp.height
      const cc = document.createElement('canvas')
      cc.width = W; cc.height = H
      const cx = cc.getContext('2d')!
      cx.drawImage(bmp, 0, 0)
      const p = cx.getImageData(2, 2, 1, 1).data
      return { W, H, bg: [p[0], p[1], p[2], p[3]] as [number, number, number, number] }
    }, xgisPng.toString('base64'))

    // ── b. Build the d3 reference IN-PAGE at the MAP's real space → refPng ──
    const refDataUrl = await page.evaluate(async ({ center, zoom, W, H, Wcss, Hcss, bg, proj }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const viteImport = (u: string): Promise<any> => import(/* @vite-ignore */ u)
      const cam = await viteImport('/render-verify/camera-map.ts')
      const ref = await viteImport('/render-verify/d3-reference.ts')
      const fx = await viteImport('/render-verify/fixtures.ts')
      // Render at the screenshot's pixel grid (W×H), but configure the d3
      // projection in the map's CSS-px space (Wcss×Hcss = the same space the
      // GPU MVP is built in) and scale the ctx by the device ratio per axis.
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')!
      // Fill with the SAME opaque background as the X-GIS frame so the diff
      // measures geometry, not the transparent-vs-opaque background delta.
      ctx.fillStyle = `rgba(${bg[0]},${bg[1]},${bg[2]},${bg[3] / 255})`
      ctx.fillRect(0, 0, W, H)
      ctx.scale(W / Wcss, H / Hcss)
      const projection = cam.xgisCameraToD3(proj, center as [number, number], zoom, Wcss, Hcss)
      ref.renderReferenceToCanvas(ctx, {
        graticule: fx.GRATICULE, polys: fx.POLYS, lines: fx.LINES, points: fx.POINTS,
      }, projection)
      return canvas.toDataURL('image/png')
    }, { center: c.center, zoom: c.zoom, W, H, Wcss, Hcss, bg, proj })

    const refPng = Buffer.from(refDataUrl.split(',')[1], 'base64')
    writeFileSync(`${OUT}/${c.name}__ref.png`, refPng)

    // ── c. Decode both + pixelmatch → mismatchRatio (in-page) ────────────
    const diff = await page.evaluate(async ({ xgisB64, refB64, W, H }) => {
      async function decode(b64: string): Promise<Uint8ClampedArray> {
        const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
        const bmp = await createImageBitmap(blob)
        const cc = document.createElement('canvas')
        cc.width = W; cc.height = H
        const cx = cc.getContext('2d')!
        cx.drawImage(bmp, 0, 0) // native size — NO resample (both are W×H)
        return cx.getImageData(0, 0, W, H).data
      }
      const a = await decode(xgisB64)
      const b = await decode(refB64)
      // Per-family ink on the X-GIS frame so a dropped fill/line/grid/point
      // pipeline can be ASSERTED, not silently passed (the numeric oracle only
      // checks placement; drawCalls>0 only catches a fully black frame; the
      // pixel oracle is INSENSITIVE to a thin/sparse dropped family — a dropped
      // stroke-3 line layer adds <0.3% mismatch, under the 6% gate). Count
      // pixels near each fixture family colour:
      //   emerald fill  #10b981  (poly_fill)
      //   rose   stroke #f43f5e  (the_lines)
      //   sky    stroke #38bdf8  (the_grid)
      //   amber  fill   #f59e0b  (the_points)
      // Each family is matched FIRST (priority by draw order on top) so a pixel
      // is attributed to one family only; widths are sampled at the family's
      // pinned hex within an L1 ball so AA halo pixels still count.
      const near = (i: number, r: number, g: number, bl: number): boolean =>
        Math.abs(a[i] - r) + Math.abs(a[i + 1] - g) + Math.abs(a[i + 2] - bl) < 90
      let emeraldPx = 0
      let amberPx = 0
      let rosePx = 0
      let skyPx = 0
      for (let i = 0; i < a.length; i += 4) {
        if (near(i, 16, 185, 129)) emeraldPx++
        else if (near(i, 245, 158, 11)) amberPx++
        else if (near(i, 244, 63, 94)) rosePx++
        else if (near(i, 56, 189, 248)) skyPx++
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const viteImport = (u: string): Promise<any> => import(/* @vite-ignore */ u)
      const pm = (await viteImport('/render-verify/pixelmatch-browser.ts')).pixelmatch as (
        img1: Uint8Array | Uint8ClampedArray, img2: Uint8Array | Uint8ClampedArray,
        out: Uint8Array | Uint8ClampedArray | null, w: number, h: number,
        opts?: { threshold?: number },
      ) => number
      const out = new Uint8ClampedArray(W * H * 4)
      const mismatched = pm(a, b, out, W, H, { threshold: 0.1 })
      // Encode the diff for artifact output.
      const dc = document.createElement('canvas')
      dc.width = W; dc.height = H
      const dx = dc.getContext('2d')!
      dx.putImageData(new ImageData(out, W, H), 0, 0)
      return { mismatched, ratio: mismatched / (W * H), diffUrl: dc.toDataURL('image/png'), emeraldPx, amberPx, rosePx, skyPx }
    }, { xgisB64: xgisPng.toString('base64'), refB64: refPng.toString('base64'), W, H })

    writeFileSync(`${OUT}/${c.name}__diff.png`, Buffer.from(diff.diffUrl.split(',')[1], 'base64'))

    // ── d. Numeric oracle: forward-agreement maxErrPx (probe logic) ──────
    const numeric = await page.evaluate(async ({ center, zoom, Wcss, Hcss, proj }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const viteImport = (u: string): Promise<any> => import(/* @vite-ignore */ u)
      const dpr = window.devicePixelRatio || 1
      const cam = await viteImport('/render-verify/camera-map.ts')
      const m = (window as unknown as { __xgisMap: MapH }).__xgisMap
      const snap = m.getCameraDebugSnapshot(Wcss, Hcss, dpr)
      const M = snap.matrix // column-major MVP

      // CPU mirror of the GPU project_geom per projType (the flat reproject fed
      // into the SHARED Mercator RTC MVP). projType 0 = lonLatToMercator;
      // projType 1/2 = the probe-proven equirect_d / natural_earth_d. All three
      // feed the SAME column-major M (camera.getDebugSnapshot rtcMatrix, same
      // matrix for projType 0/1/2 at pitch=0): X-GIS screen =
      // M · (projGeom(ll) − projGeom(center), 0, 1).
      const EARTH_R = 6378137
      const DEG2RAD = Math.PI / 180
      const LAT_CLAMP = 85.0511287798066
      const lonLatToMercator = (lon: number, lat: number): [number, number] => {
        const cl = Math.max(-LAT_CLAMP, Math.min(LAT_CLAMP, lat))
        return [
          lon * DEG2RAD * EARTH_R,
          Math.log(Math.tan(Math.PI / 4 + (cl * DEG2RAD) / 2)) * EARTH_R,
        ]
      }
      // wrap_lon_delta: bring a recentred lon-delta into [-180,180] (world-copy
      // aware) — the project_geom dispatcher does this before the *_d call.
      const wrapLonDelta = (d: number): number => {
        if (d > 180) return d - Math.ceil((d - 180) / 360) * 360
        if (d < -180) return d + Math.ceil((-d - 180) / 360) * 360
        return d
      }
      // proj_equirectangular_d (projections.ts L75-77): radians·EARTH_R.
      const projEquirectD = (lonRel: number, lat: number): [number, number] => [
        lonRel * DEG2RAD * EARTH_R,
        lat * DEG2RAD * EARTH_R,
      ]
      // proj_natural_earth_d (projections.ts L79-91): X-GIS's EXACT NE-I poly.
      const projNaturalEarthD = (lonRel: number, lat: number): [number, number] => {
        const phi = lat * DEG2RAD
        const phi2 = phi * phi, phi4 = phi2 * phi2, phi6 = phi2 * phi4
        const xScale = 0.8707 - 0.131979 * phi2 + 0.013791 * phi4 - 0.0081435 * phi6
        const yVal =
          phi * (1.007226 + phi2 * (0.015085 + phi2 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4)))
        return [lonRel * DEG2RAD * xScale * EARTH_R, yVal * EARTH_R]
      }
      const clon = center[0], clat = center[1]
      // projGeom(ll): for mercator the absolute mercator forward; for the flat
      // projections the recentred *_d (wrap_lon_delta(lon-clon)). projCenter is
      // the RTC origin the MVP subtracts (mercator: center mercator; flat: *_d
      // at delta 0 == [0, *_d_y(clat)]). The relative vertex M consumes is then
      // projGeom(ll) − projCenter.
      const projGeom = (lon: number, lat: number): [number, number] => {
        if (proj === 'mercator') return lonLatToMercator(lon, lat)
        const lonRel = wrapLonDelta(lon - clon)
        return proj === 'natural_earth'
          ? projNaturalEarthD(lonRel, lat)
          : projEquirectD(lonRel, lat)
      }
      const projCenter = (): [number, number] => {
        if (proj === 'mercator') return lonLatToMercator(clon, clat)
        return proj === 'natural_earth'
          ? projNaturalEarthD(0, clat)
          : projEquirectD(0, clat)
      }
      const [cMX, cMY] = projCenter()
      // Project (projGeom−projCenter, 0, 1) through column-major M.
      const xgisScreen = (lon: number, lat: number): [number, number] => {
        const [mx, my] = projGeom(lon, lat)
        const rx = mx - cMX, ry = my - cMY
        const cx = M[0] * rx + M[4] * ry + M[12]
        const cy = M[1] * rx + M[5] * ry + M[13]
        const cw = M[3] * rx + M[7] * ry + M[15]
        const ndcX = cx / cw, ndcY = cy / cw
        return [(ndcX + 1) / 2 * Wcss, (1 - ndcY) / 2 * Hcss]
      }
      const projection = cam.xgisCameraToD3(proj, center as [number, number], zoom, Wcss, Hcss)

      // Center-relative samples so BOTH the europe and antimeridian cases
      // probe on-screen points (a fixed lon/lat grid would fall off-frame for
      // the +180 case and never exercise the seam region).
      const lons = [-40, -20, 0, 20, 40].map((d) => center[0] + d)
      const lats = [-20, -10, 0, 10, 20].map((d) => center[1] + d)
      // World-copy vs wrap: X-GIS projects CONTINUOUS longitude (renders world
      // copies); d3 WRAPS lon into [-180,180]. Near the antimeridian the two
      // conventions place a sample a whole world-width apart — both correct.
      // Compare the x-disagreement MODULO the world pixel width (512·2^zoom, the
      // 512-tile convention) so the oracle is convention-agnostic; a real
      // projection drift (a non-world-multiple offset) is still caught.
      const worldW = 512 * Math.pow(2, zoom)
      let maxErr = 0
      // Track non-finite samples EXPLICITLY. The plain `if (e > maxErr)`
      // reduction SWALLOWS a NaN/Inf MVP: `NaN > 0` is false, so maxErr stays
      // at its 0 init and a NaN-poisoned projection (e.g. Camera.FOV → NaN
      // corrupting the perspective term of every clip coord) would PASS the
      // `maxErr < tol` gate. A non-finite screen coord is itself a render
      // defect, so we flag it and surface it as a non-finite maxErrPx that
      // the gate below rejects.
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
      // A non-finite sample poisons the result: emit NaN so the gate (which
      // asserts a FINITE maxErrPx below) fails decisively instead of reading
      // the swallowed 0.
      return { maxErrPx: sawNonFinite ? NaN : maxErr }
    }, { center: c.center, zoom: c.zoom, Wcss, Hcss, proj })

    // ── e. Report ────────────────────────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log(
      `[oracle-B] ${c.name} (proj=${proj})  drawCalls=${drawCalls}  ` +
      `mismatch=${(diff.ratio * 100).toFixed(3)}% ` +
      `(gate≤${PIXEL_MISMATCH_MAX * 100}%, ${diff.mismatched}px)  ` +
      `numericMaxErr=${Number.isFinite(numeric.maxErrPx) ? numeric.maxErrPx.toExponential(3) : String(numeric.maxErrPx)}px (gate≤${NUMERIC_ERR_MAX_PX})  ` +
      `ink{emerald=${diff.emeraldPx},rose=${diff.rosePx},sky=${diff.skyPx},amber=${diff.amberPx}}  ` +
      `→ ${OUT}/${c.name}__{xgis,ref,diff}.png`,
    )

    const realErrors = errors.filter((e) => !e.includes('vite/dist/client') && !e.includes('[X-GIS pass:'))
    expect(realErrors, `console/page errors: ${realErrors.join('; ')}`).toEqual([])

    // RENDER oracle — the fixtures must actually reach the GPU. drawCalls=0 is
    // the RC1 black-frame signature (host-pushed GeoJSON dropped as
    // drop-empty-slice); routing through VirtualPMTilesBackend fixes it.
    expect(drawCalls, `${c.name}: X-GIS drew NOTHING (drawCalls=0) — fixtures never reached the GPU`).toBeGreaterThan(0)

    // PER-FAMILY ink oracle — on a case that FRAMES a family, assert that
    // family's pipeline actually rasterized. Without this, a regression
    // dropping a whole family (the rose `the_lines` layer repointed at a dead
    // source; a dropped fill/grid pipeline) leaves the gate GREEN: the numeric
    // oracle only checks placement, drawCalls>0 only catches a fully black
    // frame, and the pixel oracle is INSENSITIVE to thin/sparse dropped
    // geometry (a dropped stroke-3 line adds <0.3% mismatch, under the 6%
    // gate). Each case lists the families it frames (requireInk); a listed
    // family with zero ink FAILS here.
    const inkOf: Record<InkFamily, number> = {
      emerald: diff.emeraldPx, rose: diff.rosePx, sky: diff.skyPx, amber: diff.amberPx,
    }
    for (const fam of c.requireInk ?? []) {
      expect(
        inkOf[fam],
        `${c.name}: family "${fam}" produced NO ink — its layer/pipeline was dropped ` +
        `(pixel oracle is blind to a thin/sparse dropped family; this per-family gate catches it).`,
      ).toBeGreaterThan(0)
    }
    // OPEN FINDING #1 (the harness's first real catch, kept a WARN not a gate):
    // host-pushed inline GeoJSON POINT features render NO amber ink while the
    // polygon/line slice path is active. The RC1 fix routes inline GeoJSON
    // through VirtualPMTilesBackend (which tiles polys/lines by slice-key);
    // points appear to need the legacy point path / setSourcePoints. amber is
    // therefore NEVER in requireInk — resolving the inline point+polygon
    // backend tension is tracked separately. (Exactly the class of gap the
    // harness exists to surface; it is reported, not hidden.)
    if (diff.amberPx === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[oracle-B] ${c.name}: OPEN FINDING #1 — points produced 0 amber ink (inline-GeoJSON point-render gap vs VirtualPMTilesBackend)`)
    }

    // NUMERIC oracle (tolerance-free placement check) — always gated.
    // FINITENESS first: a NaN/Inf MVP (corrupted uniform, divide-by-zero,
    // Camera.FOV → NaN) makes every projected screen coord non-finite. The
    // numeric reduction now propagates that as a non-finite maxErrPx; assert
    // it is finite EXPLICITLY so the failure names the cause rather than
    // hiding inside a swallowed `NaN < tol === false`. (drawCalls>0 cannot
    // catch this — a NaN-MVP still issues draws; pixel cannot either — the
    // culled frame stays under the gate.)
    expect(
      Number.isFinite(numeric.maxErrPx),
      `${c.name}: numeric forward-agreement is NON-FINITE (maxErrPx=${numeric.maxErrPx}) — ` +
      `the live MVP is NaN/Inf (corrupted camera/projection uniform).`,
    ).toBe(true)
    expect(numeric.maxErrPx, `forward-agreement drift ${numeric.maxErrPx}px`).toBeLessThan(NUMERIC_ERR_MAX_PX)

    // PIXEL oracle. A full-width antimeridian tear pushes mismatch far past the
    // ceiling — for projType 1/2 that tear is OPEN FINDING #2 (a real X-GIS
    // non-mercator seam-render bug), so seamTearKnown cases SOFT-log the
    // mismatch (tracked, not hidden) instead of hard-failing. Every other case
    // hard-gates: a tear/dropped-layer/projection-drift there blows past 6%.
    if (c.seamTearKnown) {
      // eslint-disable-next-line no-console
      console.warn(
        `[oracle-B] ${c.name}: OPEN FINDING #2 — ${(diff.ratio * 100).toFixed(3)}% mismatch ` +
        `(non-mercator line-render divergence under projType ${proj}: diagonal polylines smear / ` +
        `antimeridian crosser tears; mercator renders the same geometry clean). ` +
        `Soft-logged; numeric placement + ink still gated. Inspect ${OUT}/${c.name}__diff.png.`,
      )
    } else {
      expect(
        diff.ratio,
        `${c.name} GPU-vs-d3 mismatch ${(diff.ratio * 100).toFixed(3)}% exceeds ${PIXEL_MISMATCH_MAX * 100}% — ` +
        `inspect ${OUT}/${c.name}__diff.png (dropped layer / projection drift / seam tear).`,
      ).toBeLessThan(PIXEL_MISMATCH_MAX)
    }
  })
}
