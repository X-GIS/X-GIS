// ═══ #2093 — closing gate: OFM Positron on the globe at the user's camera ═══
//
// The report this campaign closes: at #9.70/37.54704/126.81412 the WebGPU globe
// drew Positron's roads and boundaries visibly softer than mercator, because
// EVERY vector layer rasterized into a fixed 512px DPR-blind single-sample tile
// bake and was draped onto the sphere grid (vector-tile-renderer.ts:3615 —
// `_drapeGlobeFills` / `_drapeStrokes`). The F1 fix is a LOD ceiling: at and
// above `GLOBE_DIRECT_MIN_SELECTION_Z` (geo/src/projections-table.ts:305) the
// frame's maxLevel-clamped `currentZ` puts the route on the DIRECT ECEF path,
// where geometry is magnified instead of a texture. Below the ceiling — and for
// any source whose maxLevel keeps `currentZ` under it — the bake→drape stays,
// with its great-circle hug and its #2024 windowed overzoom.
//
// This gate is the campaign's closing statement at the REPORTED camera, in the
// §12 cause → effect → sever order:
//
//   1. CAUSE   every vt source renders DIRECT this frame (`_drapeGlobeFills` and
//              `_drapeStrokes` false) and bakes ZERO NEW keys across a forced
//              repaint — the mechanism, asserted before any pixel.
//   2. EFFECT  the frame's own stroke edges are native-sharp: the 10-90%
//              intensity ramp across a road/boundary edge, measured
//              PERPENDICULAR to the edge, and the styled width recovered as the
//              50%-crossing span (FWHM).
//   3. SEVER   the same URL with `__XGIS_FORCE_VECTOR_DRAPE` holding the drape
//              above the ceiling. The lever is PROVEN flipped (in-page flag +
//              `_drapeGlobeFills` true + baked keys > 0) BEFORE its softer ramp
//              is asserted — an A/B whose arms cannot be told apart is the trap
//              this repo paid for in `_adaptive-quality-ladder-gate` (§12).
//   4. PARITY  the globe-direct frame vs the mercator frame at the same camera,
//              on STRUCTURE only — top-decile gradient energy and per-class
//              painted-pixel fraction. Deliberately NOT registration: SwiftShader
//              carries the #2025 f32 `ecefFromMerc` residue (~3px at z9), so a
//              sub-3px globe↔mercator position assert would measure the residue,
//              not this change.
//
// Chromium here has no egress — the OFM style/tiles/glyphs arrive through
// `installOfflineProxy` (node-side curl + on-disk cache). A remote asset that
// cannot be fetched is fulfilled as 404, so the counter below turns "the map is
// blank" into "N remote assets 404'd" instead of a mystery.

import { test, expect, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureMapFrame, type RGB } from './helpers/visual'
import { installOfflineProxy } from './helpers/offline-proxy'

const HERE = dirname(fileURLToPath(import.meta.url))
// Shared with the INC-1 probe on purpose: the byte cache is keyed by URL, so a
// run that follows a probe run pays no fetches at all.
const NET_CACHE = join(HERE, '__net-cache__')

const DEMO_ID = 'openfreemap_positron'
const CAMERA = '9.70/37.54704/126.81412'
/** Playwright captures at the context's deviceScaleFactor, so 1 CSS px of styled
 *  width is DPR device px in the returned PNG. Pinned, and re-asserted in-page
 *  against the engine's own canvas backing scale before any width is judged. */
const DPR = 2

// ── Positron palette at this camera (established, not re-derived here) ──
const BG: RGB = [242, 243, 240]
const CASING: RGB = [213, 213, 213] // highway_motorway_casing
const BOUNDARY: RGB = [178, 178, 178] // boundary_2
const WHITE: RGB = [255, 255, 255] // motorway inner fill

/** Styled CSS widths at z9.7, from the campaign's style read. */
const STYLED_CSS_PX: Record<string, number> = { boundary: 2.41, casing: 3.84 }

// ── Thresholds (every one justified in the report; measured numbers are printed
//    on both the pass and fail paths so a re-calibration never needs a re-run) ──
//
// A natively-drawn analytic-AA edge feathers over `halfAa = 0.5/dpr` CSS px per
// side (line.ts:899) = 1 device px of total band at DPR 2, whose 10-90% portion
// is 0.8 device px. 1.6 is 2x that floor — headroom for SwiftShader's resolve
// and for the ≤12% residual obliquity the orientation filter admits — and still
// far under one bake texel (1.6 device px at this camera), which the drape can
// never beat.
const SHARP_RAMP_MAX_DEVICE_PX = 1.6
// The drape's ramp is a 1-bake-texel edge reconstructed bilinearly, i.e. ≈2
// texels of ramp = 3.2 device px here, 10-90% ≈ 2.56. 2.5 is that value less a
// thin margin: the sever arm must land ABOVE it, so the bound is a floor on how
// much softer holding the drape actually is.
const DRAPED_RAMP_MIN_DEVICE_PX = 2.5
/** Styled-width contract band. ±15% absorbs the 50%-crossing estimator's
 *  sub-pixel bias and SwiftShader's coverage rounding; a bake-magnified stroke
 *  misses it by far more than 15%. */
const WIDTH_TOL = 0.15
/** Globe-vs-mercator sharpness energy. The top-decile gradient mean is
 *  scale-free; between two DIRECT frames of the same content it moves only with
 *  the sphere's few-% scale variation across the frame, while a 512px bake
 *  halves it. 25% separates those two regimes without pretending the two
 *  projections show the identical pixels. */
const GRADIENT_TOL = 0.25
/** Per-class painted-pixel fraction, in PERCENTAGE POINTS. Coarse on purpose:
 *  it is a "the same map is on screen" structural check, not a parity metric. */
const CLASS_FRACTION_TOL_PP = 0.1
/** Non-vacuity floor — a median over fewer distinct edges is not a measurement.
 *  Distinct EDGES, not rows: one long road contributes hundreds of rows. */
const MIN_DISTINCT_EDGES = 3
/** Convergence budget. SwiftShader's globe cells at this camera were measured
 *  still carrying a 288-upload residual after 150 s (#2053 class), so the poll
 *  gets 5 minutes and a non-zero residual FAILS — a half-loaded frame is not the
 *  converged frame, and must never be measured as one. */
const DRAIN_BUDGET_MS = 300_000

// 20 min per test at file scope so FIXTURE setup is covered too (§12: a budget
// declared inside the body leaves context creation on the config default, which
// is where a loaded SwiftShader runner actually times out).
test.describe.configure({ timeout: 1_200_000 })
test.use({ deviceScaleFactor: DPR })

type Win = Window & {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __XGIS_FORCE_VECTOR_DRAPE?: boolean
  __xgisMap?: {
    invalidate?: () => void
    vtSources?: Map<
      string,
      {
        renderer: Record<string, unknown> & { getPendingUploadCount?: () => number }
        source: { getPendingLoadCount?: () => number; maxLevel?: number }
      }
    >
  }
}

interface SourceState {
  drapeGlobeFills: boolean
  drapeStrokes: boolean
  maxLevel: number
  bakedKeys: string[]
}
interface DrainResult {
  convergedMs: number
  residualUploads: number
  residualLoads: number
}
interface ClassStats {
  /** rows that survived every filter */
  samples: number
  /** distinct edges — row samples clustered by x-position continuity */
  edges: number
  /** median perpendicular 10-90% ramp width, device px (-1 = no samples) */
  medianRamp: number
  /** median perpendicular 50%-crossing span (FWHM), device px (-1 = none) */
  medianWidth: number
  /** fraction of frame pixels inside this class's colour band */
  pixelFraction: number
}
interface FrameStats {
  width: number
  height: number
  perClass: Record<string, ClassStats>
  pooledSamples: number
  pooledEdges: number
  /** median ramp over every class's samples pooled (-1 = none) */
  medianRamp: number
  bgFraction: number
  topDecileGradient: number
  rejected: { lowContrast: number; oblique: number; span: number }
}

function demoUrl(opts: { globe: boolean }): string {
  const params = new URLSearchParams({ id: DEMO_ID, e2e: '1', adaptive: '0' })
  if (opts.globe) params.set('proj', 'globe')
  return `/demo.html?${params.toString()}#${CAMERA}`
}

/** Remote assets the offline proxy could not fetch. A blank Positron frame is
 *  almost always this, and saying so beats re-debugging the renderer. */
function attachNetworkFailureCounter(page: Page, sink: string[]): void {
  page.on('response', (r) => {
    const url = r.url()
    if (r.status() === 404 && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
      if (sink.length < 20) sink.push(url.slice(0, 120))
    }
  })
}

async function gotoDemo(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  // 180 s, not 60: the DIRECT arm at this camera submits + software-rasterizes
  // far more raw geometry than the drape's textured quads, and a fresh context
  // also pays cold shader-variant compilation (measured by the INC-1 probe).
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 180_000,
  })
}

// Drape-state introspection recipe from _globe-drape-overzoom-gate.spec.ts:136-149
// (`__xgisMap.vtSources` → `renderer['_drapeGlobeFills']` / `['_drapeStrokes']` /
// `renderer['_drape'].baked`), plus the source's `maxLevel` (currentZ is clamped
// to it, so it decides which side of the ceiling this frame is on).
async function dumpSources(page: Page): Promise<Record<string, SourceState>> {
  return page.evaluate(() => {
    const out: Record<string, SourceState> = {}
    const vt = (window as unknown as Win).__xgisMap?.vtSources
    if (vt) {
      for (const [name, entry] of vt) {
        const r = entry.renderer
        const drape = r['_drape'] as { baked?: Map<string, unknown> } | undefined
        out[name] = {
          drapeGlobeFills: r['_drapeGlobeFills'] === true,
          drapeStrokes: r['_drapeStrokes'] === true,
          maxLevel: entry.source.maxLevel ?? -1,
          bakedKeys: [...(drape?.baked?.keys() ?? [])],
        }
      }
    }
    return out
  })
}

/** Force `frames` repaints on a render-on-demand engine. No `waitForTimeout`:
 *  the wait IS the frame callback (capture-canvas skill). */
async function pumpFrames(page: Page, frames: number): Promise<void> {
  await page.evaluate(async (n) => {
    const w = window as unknown as Win
    for (let i = 0; i < n; i++) {
      w.__xgisMap?.invalidate?.()
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
    }
  }, frames)
}

// Drain the GPU-upload backlog before trusting a captured frame (§12 — "the map
// fossilized half-loaded"). `captureMapFrame`'s own quiesce waits for
// `hasPendingSourceWork()` to clear but never `invalidate()`s to force draining,
// so a render-on-demand engine can idle with uploads still pending and that poll
// times out silently. Same methodology as measure-harness's converge() and the
// INC-1 probe's drainUploads, so their numbers are comparable to these. The
// residual is RETURNED, never hidden — the caller asserts it is zero.
async function drainUploads(page: Page, budgetMs: number): Promise<DrainResult> {
  return page.evaluate(async (budget) => {
    const w = window as unknown as Win
    const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const counts = (): { uploads: number; loads: number } => {
      let uploads = 0
      let loads = 0
      const vt = w.__xgisMap?.vtSources
      if (vt) {
        for (const [, entry] of vt) {
          uploads += entry.renderer.getPendingUploadCount?.() ?? 0
          loads += entry.source.getPendingLoadCount?.() ?? 0
        }
      }
      return { uploads, loads }
    }
    const t0 = performance.now()
    let stable = 0
    while (performance.now() - t0 < budget) {
      const { uploads, loads } = counts()
      const busy = uploads > 0 || loads > 0
      stable = busy ? 0 : stable + 1
      if (stable >= 5) break
      if (busy) w.__xgisMap?.invalidate?.()
      await nextFrame()
      await sleep(30)
    }
    const final = counts()
    return {
      convergedMs: Math.round(performance.now() - t0),
      residualUploads: final.uploads,
      residualLoads: final.loads,
    }
  }, budgetMs)
}

/**
 * The measurement. Decodes the captured PNG in the page (repo idiom — no
 * node-side image dependency) and, per stroke class, walks every row for a
 * BG → class → BG pair, then reports:
 *
 *   • ramp   the 10-90% intensity ramp across the outer transition. A hard edge
 *            between two samples measures 0.8 px; a magnified bake texel is
 *            wider by construction. Measured on both sides and averaged.
 *   • width  the span between the two 50% crossings (FWHM). For a symmetric
 *            coverage-AA profile that IS the geometric width — the core colour
 *            RUN underestimates it, because the AA feather eats into it, and a
 *            motorway's white inner fill breaks a simple thresholded span.
 *
 * Both are projected PERPENDICULAR to the edge (× cos(atan(slope))): a row scan
 * across a tilted edge stretches by 1/cos, which would otherwise flatter the
 * drape arm and penalize the direct one. Edges steeper than `maxSlope` from
 * vertical are dropped outright — beyond that the correction stops being small.
 */
async function analyzeFrame(page: Page, png: Buffer): Promise<FrameStats> {
  return page.evaluate(
    async (args: {
      b64: string
      bg: RGB
      classes: Array<{ name: string; rgb: RGB; tol: number }>
      bgTol: number
      neutralTol: number
      maxGap: number
      maxSpan: number
      minStep: number
      maxSlope: number
      clusterTol: number
    }) => {
      const blob = await fetch(`data:image/png;base64,${args.b64}`).then((r) => r.blob())
      const bmp = await createImageBitmap(blob)
      const off = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = off.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const w = bmp.width
      const h = bmp.height
      const d = ctx.getImageData(0, 0, w, h).data
      const n = w * h

      const L = new Float32Array(n)
      for (let p = 0; p < n; p++) {
        const i = p * 4
        L[p] = (d[i] + d[i + 1] + d[i + 2]) / 3
      }
      const isBg = (i: number): boolean =>
        Math.abs(d[i] - args.bg[0]) <= args.bgTol &&
        Math.abs(d[i + 1] - args.bg[1]) <= args.bgTol &&
        Math.abs(d[i + 2] - args.bg[2]) <= args.bgTol
      const isNeutral = (i: number): boolean =>
        Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) <= args.neutralTol
      const nearRgb = (i: number, rgb: RGB, tol: number): boolean =>
        Math.abs(d[i] - rgb[0]) <= tol &&
        Math.abs(d[i + 1] - rgb[1]) <= tol &&
        Math.abs(d[i + 2] - rgb[2]) <= tol

      let bgPixels = 0
      for (let p = 0; p < n; p++) if (isBg(p * 4)) bgPixels++

      const median = (v: number[]): number => {
        if (v.length === 0) return -1
        const s = [...v].sort((a, b) => a - b)
        const m = s.length >> 1
        return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2
      }

      /** 10-90% ramp and 50% crossing between a background sample and a class
       *  sample on the same row. `null` when the step is too small to be an
       *  edge at all (noise, or a class pixel sitting on non-background). */
      const rampAt = (
        base: number,
        xBg: number,
        xCls: number,
      ): { ramp: number; x50: number } | null => {
        const lo = L[base + xBg]
        const hi = L[base + xCls]
        const step = lo - hi
        if (step < args.minStep) return null
        const dir = xCls > xBg ? 1 : -1
        const span = Math.abs(xCls - xBg)
        const tAt = (k: number): number => (lo - L[base + xBg + dir * k]) / step
        const cross = (level: number): number => {
          for (let k = 1; k <= span; k++) {
            const t1 = tAt(k)
            if (t1 >= level) {
              const t0 = tAt(k - 1)
              return t1 === t0 ? k : k - 1 + (level - t0) / (t1 - t0)
            }
          }
          return span
        }
        return { ramp: cross(0.9) - cross(0.1), x50: xBg + dir * cross(0.5) }
      }

      const cat = new Uint8Array(w)
      /** bg → class transition: last bg index `a`, first class index `b`, only
       *  intermediate ("other") samples in between. */
      const findFalling = (from: number): { a: number; b: number } | null => {
        for (let a = from; a < w - 1; a++) {
          if (cat[a] !== 0) continue
          let b = a + 1
          while (b < w && cat[b] === 2 && b - a <= args.maxGap) b++
          if (b < w && cat[b] === 1 && b - a <= args.maxGap + 1) return { a, b }
        }
        return null
      }
      /** class → bg transition: last class index `a`, first bg index `b`. */
      const findRising = (from: number): { a: number; b: number } | null => {
        for (let b = from + 1; b < w; b++) {
          if (cat[b] !== 0) continue
          let a = b - 1
          while (a > from && cat[a] === 2 && b - a <= args.maxGap) a--
          if (cat[a] === 1 && b - a <= args.maxGap + 1) return { a, b }
        }
        return null
      }

      const rejected = { lowContrast: 0, oblique: 0, span: 0 }
      const perClass: Record<string, ClassStats> = {}
      const pooled: number[] = []
      let pooledEdges = 0

      for (const cls of args.classes) {
        const rows: Array<Array<{ x50L: number; x50R: number; ramp: number; width: number }>> = []
        for (let y = 0; y < h; y++) rows.push([])
        let classPixels = 0

        for (let y = 0; y < h; y++) {
          const base = y * w
          for (let x = 0; x < w; x++) {
            const i = (base + x) * 4
            const c = isBg(i) ? 0 : isNeutral(i) && nearRgb(i, cls.rgb, cls.tol) ? 1 : 2
            cat[x] = c
            if (c === 1) classPixels++
          }
          let x = 0
          while (x < w - 1) {
            const fall = findFalling(x)
            if (!fall) break
            const rise = findRising(fall.b)
            if (!rise) break
            // `findRising` returns the FIRST background sample after `fall.b`, so
            // the pair brackets exactly one stroke — no background can sit inside
            // it, and the row scan resumes from that background sample.
            x = rise.b
            if (rise.b - fall.a > args.maxSpan) {
              rejected.span++
              continue
            }
            const left = rampAt(base, fall.a, fall.b)
            const right = rampAt(base, rise.b, rise.a)
            if (!left || !right) {
              rejected.lowContrast++
              continue
            }
            rows[y].push({
              x50L: left.x50,
              x50R: right.x50,
              ramp: (left.ramp + right.ramp) / 2,
              width: right.x50 - left.x50,
            })
          }
        }

        // Orientation filter + edge clustering. Clustering runs over EVERY
        // detected row sample (not only the kept ones) so a single rejected row
        // cannot split one road into two "distinct edges"; a cluster counts only
        // if at least one of its rows survived.
        const nearestX = (list: Array<{ x50L: number }>, x: number, tol: number): number | null => {
          let best: number | null = null
          let bestD = tol
          for (const e of list) {
            const dd = Math.abs(e.x50L - x)
            if (dd <= bestD) {
              bestD = dd
              best = e.x50L
            }
          }
          return best
        }
        const ramps: number[] = []
        const widths: number[] = []
        const clusterKept: boolean[] = []
        let prev: Array<{ x: number; id: number }> = []
        for (let y = 1; y < h - 1; y++) {
          const cur: Array<{ x: number; id: number }> = []
          for (const e of rows[y]) {
            let id = -1
            for (const q of prev)
              if (Math.abs(q.x - e.x50L) <= args.clusterTol) {
                id = q.id
                break
              }
            if (id < 0) {
              id = clusterKept.length
              clusterKept.push(false)
            }
            cur.push({ x: e.x50L, id })

            const before = nearestX(rows[y - 1], e.x50L, 3)
            const after = nearestX(rows[y + 1], e.x50L, 3)
            if (before === null || after === null) {
              rejected.oblique++
              continue
            }
            const slope = Math.abs(after - before) / 2
            if (slope > args.maxSlope) {
              rejected.oblique++
              continue
            }
            const perp = Math.cos(Math.atan(slope))
            ramps.push(e.ramp * perp)
            widths.push(e.width * perp)
            clusterKept[id] = true
          }
          prev = cur
        }

        const edges = clusterKept.filter(Boolean).length
        perClass[cls.name] = {
          samples: ramps.length,
          edges,
          medianRamp: median(ramps),
          medianWidth: median(widths),
          pixelFraction: classPixels / n,
        }
        for (const v of ramps) pooled.push(v)
        pooledEdges += edges
      }

      // Top-decile gradient magnitude — the frame's sharpness energy, dominated
      // by the sharpest edges present and independent of how many there are.
      const gN = (w - 2) * (h - 2)
      const g = new Float32Array(gN)
      let gi = 0
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const p = y * w + x
          const gx = L[p + 1] - L[p - 1]
          const gy = L[p + w] - L[p - w]
          g[gi++] = Math.sqrt(gx * gx + gy * gy)
        }
      }
      g.sort()
      const from = Math.floor(gN * 0.9)
      let sum = 0
      for (let k = from; k < gN; k++) sum += g[k]

      return {
        width: w,
        height: h,
        perClass,
        pooledSamples: pooled.length,
        pooledEdges,
        medianRamp: median(pooled),
        bgFraction: bgPixels / n,
        topDecileGradient: sum / (gN - from),
        rejected,
      }
    },
    {
      b64: png.toString('base64'),
      bg: BG,
      // `white` is the motorway inner fill: BRIGHTER than the background, so its
      // bg→class step is negative and it contributes ZERO ramp samples by
      // construction. It is here for the per-class painted-pixel fraction the
      // parity arm compares, not for sharpness.
      classes: [
        { name: 'casing', rgb: CASING, tol: 10 },
        { name: 'boundary', rgb: BOUNDARY, tol: 10 },
        { name: 'white', rgb: WHITE, tol: 6 },
      ],
      bgTol: 6,
      neutralTol: 8,
      // A ramp wider than 16 device px is not a stroke edge at this camera even
      // on the drape; admitting more would start counting gradients between
      // landuse fills. Deliberately generous: clipping the drape arm's widest
      // ramps would flatter it, which is the wrong direction for a sever arm.
      maxGap: 16,
      // Widest plausible stroke at this camera (motorway casing 3.84 CSS px ×
      // DPR 2 ≈ 7.7 device px, plus both ramps) with room to spare.
      maxSpan: 40,
      // Luminance step that makes an edge an edge. Casing-vs-background is the
      // smallest real one here (241.7 → 213 ≈ 28.7).
      minStep: 15,
      // |dx/dy| ≤ 0.5 — within 26.6° of vertical, where the perpendicular
      // correction is ≤ 12% and stays a correction rather than a guess.
      maxSlope: 0.5,
      clusterTol: 3,
    },
  )
}

/** Human-readable one-liner for logs and failure messages — numbers first. */
function describeStats(label: string, s: FrameStats): string {
  const cls = Object.entries(s.perClass)
    .map(
      ([k, v]) =>
        `${k}{edges:${v.edges},rows:${v.samples},ramp:${v.medianRamp.toFixed(2)},` +
        `w:${v.medianWidth.toFixed(2)},px:${(v.pixelFraction * 100).toFixed(3)}%}`,
    )
    .join(' ')
  return (
    `${label}: ${s.width}x${s.height} medianRamp=${s.medianRamp.toFixed(2)}dev-px ` +
    `edges=${s.pooledEdges} rows=${s.pooledSamples} bg=${(s.bgFraction * 100).toFixed(1)}% ` +
    `grad(top10%)=${s.topDecileGradient.toFixed(2)} rejected=${JSON.stringify(s.rejected)} ${cls}`
  )
}

/** Boot + converge + prove the capture premises (backend, DPR). Shared by all
 *  three tests: every one of them measures device px against a styled CSS width,
 *  and a WebGL2 fallback would green the direct arm vacuously (the drape is
 *  WebGPU-only, vector-tile-renderer.ts:3623). */
async function bootAndConverge(
  page: Page,
  url: string,
  net: string[],
): Promise<{ drain: DrainResult; backend: string; backingScale: number }> {
  await gotoDemo(page, url)
  const drain = await drainUploads(page, DRAIN_BUDGET_MS)
  const probe = await page.evaluate(() => {
    const cv = document.getElementById('map') as HTMLCanvasElement | null
    return {
      backend: (window as unknown as Win).__xgisActiveBackend ?? 'unknown',
      backingScale: cv && cv.clientWidth > 0 ? cv.width / cv.clientWidth : -1,
    }
  })
  expect(
    drain.residualUploads + drain.residualLoads,
    `the engine never converged at ${url} — ${drain.residualUploads} uploads / ` +
      `${drain.residualLoads} loads still pending after ${drain.convergedMs}ms. ` +
      `A half-loaded frame is not the converged frame (#2053) and must not be measured. ` +
      `${net.length} remote asset(s) 404'd through the offline proxy${net.length ? `: ${net.join(' | ')}` : ''}`,
  ).toBe(0)
  expect(
    probe.backend,
    'the drape is WebGPU-only (vector-tile-renderer.ts:3623), so a WebGL2 fallback would ' +
      'green the direct arm without the #2093 ceiling doing anything',
  ).toBe('webgpu')
  expect(
    probe.backingScale,
    `canvas backing scale ${probe.backingScale} — every width below is judged in device px ` +
      `against a styled CSS width times DPR ${DPR}, so the engine must actually be rendering ` +
      `at that scale (an adaptive-DPR clamp here would silently double every measured width)`,
  ).toBeCloseTo(DPR, 2)
  return { drain, ...probe }
}

test('#2093 — Positron on the globe @ z9.7 renders DIRECT, with native-sharp strokes', async ({
  page,
}) => {
  const errors: string[] = []
  const net: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  attachNetworkFailureCounter(page, net)
  await page.setViewportSize({ width: 1024, height: 768 })
  await installOfflineProxy(page, { cacheDir: NET_CACHE })

  await bootAndConverge(page, demoUrl({ globe: true }), net)

  // ── CAUSE (§12: the mechanism, before any pixel) ────────────────────────────
  const before = await dumpSources(page)
  await pumpFrames(page, 30)
  const after = await dumpSources(page)

  const names = Object.keys(after)
  expect(
    names.length,
    'no vt source on the page — the Positron style never loaded, so nothing below means ' +
      `anything. ${net.length} remote asset(s) 404'd through the offline proxy` +
      `${net.length ? `: ${net.join(' | ')}` : ''}`,
  ).toBeGreaterThan(0)

  const draping = names.filter((k) => after[k].drapeGlobeFills || after[k].drapeStrokes)
  expect(
    draping.map((k) => `${k}{fills:${after[k].drapeGlobeFills},strokes:${after[k].drapeStrokes}}`),
    `these sources still bake→drape at currentZ ≥ GLOBE_DIRECT_MIN_SELECTION_Z. The #2093 ` +
      `LOD ceiling (geo/src/projections-table.ts:305, wired at vector-tile-renderer.ts:3615) ` +
      `is not reached for them. maxLevels: ` +
      names.map((k) => `${k}:${after[k].maxLevel}`).join(' '),
  ).toEqual([])

  const newKeys = names.flatMap((k) => {
    const seen = new Set(before[k]?.bakedKeys ?? [])
    return after[k].bakedKeys.filter((key) => !seen.has(key)).map((key) => `${k}:${key}`)
  })
  expect(
    newKeys.slice(0, 20),
    'the direct path baked NEW drape textures across a forced 30-frame repaint — the flags ' +
      'above say direct while the bake cache says otherwise, so one of them is lying',
  ).toEqual([])

  // ── EFFECT ─────────────────────────────────────────────────────────────────
  const png = await captureMapFrame(page, { readyTimeoutMs: 180_000, capture: 'clip' })
  writeFileSync(test.info().outputPath('globe-direct.png'), png)
  const stats = await analyzeFrame(page, png)
  console.log(describeStats('[#2093 globe-direct]', stats))

  expect(
    stats.pooledEdges,
    `only ${stats.pooledEdges} distinct stroke edge(s) found in the frame (${stats.pooledSamples} ` +
      `rows; rejected ${JSON.stringify(stats.rejected)}). An empty population cannot pass this ` +
      `gate — either the frame is blank (${net.length} remote 404s) or the Positron palette ` +
      `moved out from under BG/CASING/BOUNDARY.`,
  ).toBeGreaterThanOrEqual(MIN_DISTINCT_EDGES)

  expect(
    stats.medianRamp,
    `median perpendicular 10-90% stroke ramp = ${stats.medianRamp.toFixed(2)} device px over ` +
      `${stats.pooledEdges} edges. A natively-drawn edge measures ≈0.8; the 512px bake→drape ` +
      `measures ≈2.6 at this camera. ${describeStats('frame', stats)}`,
  ).toBeLessThanOrEqual(SHARP_RAMP_MAX_DEVICE_PX)

  // Width contract — pick the class the frame actually contains, and say which.
  const boundary = stats.perClass.boundary
  const casing = stats.perClass.casing
  const pick =
    boundary.edges >= MIN_DISTINCT_EDGES
      ? { name: 'boundary', stats: boundary }
      : casing.edges >= MIN_DISTINCT_EDGES
        ? { name: 'casing', stats: casing }
        : null
  // Thrown, not `expect`-ed: this is the state where the contract has nothing to
  // measure, and it must not be conflated with a width that MISSED (§12 — order
  // decides which half a red run accuses).
  if (pick === null) {
    throw new Error(
      `no stroke class reached ${MIN_DISTINCT_EDGES} distinct edges, so the width contract ` +
        `has no population to assert on (boundary ${boundary.edges}, casing ${casing.edges}). ` +
        `This is NOT a width verdict. ${describeStats('frame', stats)}`,
    )
  }
  const expected = STYLED_CSS_PX[pick.name] * DPR
  expect(
    pick.stats.medianWidth,
    `${pick.name} stroke width = ${pick.stats.medianWidth.toFixed(2)} device px over ` +
      `${pick.stats.edges} edges; styled ${STYLED_CSS_PX[pick.name]} CSS px × DPR ${DPR} = ` +
      `${expected.toFixed(2)} ± ${(WIDTH_TOL * 100).toFixed(0)}%. A width miss is a different ` +
      `bug from a sharpness miss — measure before blaming either (§5).`,
  ).toBeGreaterThanOrEqual(expected * (1 - WIDTH_TOL))
  expect(pick.stats.medianWidth).toBeLessThanOrEqual(expected * (1 + WIDTH_TOL))

  expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([])
})

test('#2093 sever — holding the drape above the ceiling softens the same edges', async ({
  page,
}) => {
  const errors: string[] = []
  const net: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  attachNetworkFailureCounter(page, net)
  await page.setViewportSize({ width: 1024, height: 768 })
  await installOfflineProxy(page, { cacheDir: NET_CACHE })
  await page.addInitScript(() => {
    ;(globalThis as { __XGIS_FORCE_VECTOR_DRAPE?: boolean }).__XGIS_FORCE_VECTOR_DRAPE = true
  })

  await bootAndConverge(page, demoUrl({ globe: true }), net)

  // ── The lever must be PROVEN flipped before its effect is read. An A/B whose
  //    arms cannot be told apart fails identically either way (§12,
  //    `_adaptive-quality-ladder-gate`), and an init script that never ran is
  //    exactly that failure wearing a green tick.
  const flag = await page.evaluate(
    () => (globalThis as { __XGIS_FORCE_VECTOR_DRAPE?: boolean }).__XGIS_FORCE_VECTOR_DRAPE,
  )
  expect(
    flag,
    'the init script never reached the page — this arm would then be a second copy of the ' +
      'direct arm and its softer-ramp assertion would be measuring nothing',
  ).toBe(true)

  const state = await dumpSources(page)
  const names = Object.keys(state)
  expect(
    names.length,
    'no vt source on the page — the Positron style never loaded',
  ).toBeGreaterThan(0)
  const drapingNames = names.filter((k) => state[k].drapeGlobeFills)
  expect(
    drapingNames,
    `__XGIS_FORCE_VECTOR_DRAPE is set but no source reports _drapeGlobeFills — the override at ` +
      `vector-tile-renderer.ts:3621 is not wired, so this arm proves nothing. sources: ` +
      names
        .map((k) => `${k}{fills:${state[k].drapeGlobeFills},baked:${state[k].bakedKeys.length}}`)
        .join(' '),
  ).not.toEqual([])
  const bakedTotal = names.reduce((acc, k) => acc + state[k].bakedKeys.length, 0)
  expect(
    bakedTotal,
    'the drape flag is on but the bake cache is empty — no texture was ever baked, so the ' +
      'softer edges below would not be the drape',
  ).toBeGreaterThan(0)

  // ── EFFECT ─────────────────────────────────────────────────────────────────
  const png = await captureMapFrame(page, { readyTimeoutMs: 180_000, capture: 'clip' })
  writeFileSync(test.info().outputPath('globe-draped.png'), png)
  const stats = await analyzeFrame(page, png)
  console.log(describeStats('[#2093 globe-draped]', stats))

  expect(
    stats.pooledEdges,
    `only ${stats.pooledEdges} distinct stroke edge(s) in the draped frame ` +
      `(${stats.pooledSamples} rows; rejected ${JSON.stringify(stats.rejected)}) — an empty ` +
      `population would pass a "≥" bound for the wrong reason`,
  ).toBeGreaterThanOrEqual(MIN_DISTINCT_EDGES)

  expect(
    stats.medianRamp,
    `median perpendicular 10-90% stroke ramp with the drape held = ` +
      `${stats.medianRamp.toFixed(2)} device px. If this is as sharp as the direct arm, the ` +
      `ceiling is not what decides sharpness and the whole #2093 premise is wrong — that is ` +
      `the finding, not a flake. ${describeStats('frame', stats)}`,
  ).toBeGreaterThanOrEqual(DRAPED_RAMP_MIN_DEVICE_PX)

  expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([])
})

test('#2093 — the globe-direct frame carries mercator-class structure at the same camera', async ({
  page,
}) => {
  const errors: string[] = []
  const net: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  attachNetworkFailureCounter(page, net)
  await page.setViewportSize({ width: 1024, height: 768 })
  await installOfflineProxy(page, { cacheDir: NET_CACHE })

  // Globe first, mercator second, on the SAME page: two live WebGPU contexts in
  // one browser process livelocked SwiftShader at this camera (INC-1 probe), so
  // arms are sequential navigations, never parallel pages.
  await bootAndConverge(page, demoUrl({ globe: true }), net)
  const globePng = await captureMapFrame(page, { readyTimeoutMs: 180_000, capture: 'clip' })
  writeFileSync(test.info().outputPath('parity-globe.png'), globePng)

  await bootAndConverge(page, demoUrl({ globe: false }), net)
  const mercPng = await captureMapFrame(page, { readyTimeoutMs: 180_000, capture: 'clip' })
  writeFileSync(test.info().outputPath('parity-merc.png'), mercPng)

  const globe = await analyzeFrame(page, globePng)
  const merc = await analyzeFrame(page, mercPng)
  console.log(describeStats('[#2093 parity globe]', globe))
  console.log(describeStats('[#2093 parity merc]', merc))

  // Non-vacuity: both frames must actually be Positron frames. A blank pair
  // agrees perfectly on every metric below.
  for (const [label, s] of [
    ['globe', globe],
    ['mercator', merc],
  ] as const) {
    expect(
      s.bgFraction,
      `${label} frame is not a Positron frame — background covers ` +
        `${(s.bgFraction * 100).toFixed(1)}% of it. Two blank frames agree on every structural ` +
        `metric below, so this guard runs first. ${net.length} remote 404(s).`,
    ).toBeGreaterThan(0.2)
    expect(
      s.topDecileGradient,
      `${label} frame carries no edge energy at all (${s.topDecileGradient.toFixed(3)})`,
    ).toBeGreaterThan(1)
  }

  // Sharpness ENERGY, not position: SwiftShader's #2025 f32 ecefFromMerc residue
  // is ~3px at z9, so nothing here may assert globe↔mercator registration.
  const ratio = globe.topDecileGradient / merc.topDecileGradient
  expect(
    ratio,
    `top-decile gradient globe/mercator = ${ratio.toFixed(3)} ` +
      `(${globe.topDecileGradient.toFixed(2)} vs ${merc.topDecileGradient.toFixed(2)}). ` +
      `Below the band means the globe frame is the softer one — the exact #2093 report. ` +
      `Above it means the globe is drawing something mercator is not.`,
  ).toBeGreaterThanOrEqual(1 - GRADIENT_TOL)
  expect(ratio).toBeLessThanOrEqual(1 + GRADIENT_TOL)

  const classNames = Object.keys(merc.perClass)
  const drift = classNames
    .map((k) => ({ k, d: globe.perClass[k].pixelFraction - merc.perClass[k].pixelFraction }))
    .filter((e) => Math.abs(e.d) > CLASS_FRACTION_TOL_PP)
  expect(
    drift.map((e) => `${e.k}:${(e.d * 100).toFixed(2)}pp`),
    `per-class painted-pixel fraction drifted more than ` +
      `${(CLASS_FRACTION_TOL_PP * 100).toFixed(0)} percentage points between the globe and ` +
      `mercator frames — the two projections are no longer drawing the same map. ` +
      classNames
        .map(
          (k) =>
            `${k} globe ${(globe.perClass[k].pixelFraction * 100).toFixed(3)}% / merc ` +
            `${(merc.perClass[k].pixelFraction * 100).toFixed(3)}%`,
        )
        .join(' | '),
  ).toEqual([])

  expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([])
})
