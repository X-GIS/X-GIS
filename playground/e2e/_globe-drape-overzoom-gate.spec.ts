// ═══ #2024 — globe drape virtual-overzoom sharpness gate ═══
//
// Past the source maxLevel the tile selection re-renders maxLevel tiles
// camera-magnified. The DIRECT vector path magnifies geometry (sharp at any
// depth — why mercator never blurs); the drape used to magnify a fixed 512px
// BAKE, going soft by 2^(zoom − maxLevel) — the "globe goes low-res past the
// source max" report. The fix drapes VIRTUAL sub-tiles, each a 512px windowed
// bake of its maxLevel ancestor, restoring native texel density.
//
// ── #2093 RE-POINT (source + zoom only; the coast is the same coast) ────────
// This gate used to drive countries.geojson (runtime maxLevel 14) at z15.3.
// #2093 added a selection-zoom LOD CEILING: at/above GLOBE_DIRECT_MIN_SELECTION_Z
// the sphere route renders DIRECT, and `currentZ` is maxLevel-clamped — so a
// maxLevel-14 source at z15.3 sits at currentZ 14, well above the ceiling, and
// the drape (with it this whole windowed-overzoom mechanism) no longer runs at
// that camera at all. Measured on the fix: `_drapeGlobeFills` false, 0 baked
// keys, and this gate's cause assertion red for a reason that is not a defect.
//
// The mechanism did NOT go away — the ceiling is SOURCE-CLAMPED, so every source
// whose maxLevel is below it keeps the drape and its #2024 overzoom at EVERY
// camera zoom (projections-table.ts documents demotiles/maxzoom-2 as exactly
// this case). So the gate follows the mechanism to a source that still owns it,
// rather than being deleted or held open with a debug flag:
//
//   SOURCE  the committed offline demotiles mirror (`/vendor/demotiles-mirror`,
//           tilejson maxzoom 2 — #1495 vendored it; no egress, CI-safe), its
//           `countries` polygons under the same `fill-emerald-400`.
//   CAMERA  the ORIGINAL lon/lat, verbatim (Benghazi coast — an east-west
//           land-south coastline, so the coast edge stays in frame under the
//           per-GPU vs_tile transcendental displacement, #2025). Zoom 15.3 →
//           10.3.
//   DEPTH   overzoom Δz = camera − maxLevel goes 1.3 → 8.3. STRICTLY DEEPER
//           than what this gate used to prove.
//
// WHY 10.3 AND NOT 15.3 ON THE NEW SOURCE. `computeDrapeOverzoom` caps the
// virtual level at `maxLevel + DRAPE_OVERZOOM_MAX_BOOST` (2 + 8 = 10) and drops
// one more unless `camera.zoom > virtualZ + 1e-3`. At 10.3 the virtual set lands
// on z10, so the windowed bake carries a residual magnification of 2^(10.3−10) =
// 1.23× — IDENTICAL to the 2^(15.3−15) the old camera produced, which is what
// the 0.20 soft-band bound below was calibrated against. Same measurement scale,
// deeper overzoom. (At z15.3 the cap would pin virtualZ to 10 and the bake would
// be magnified 39×, which measures the CAP, not the windowing.)
//
// The post-ceiling direct behaviour at the OLD camera is not lost either — it is
// asserted by `_globe-direct-overzoom-sharpness-gate`, which keeps that source,
// camera and metric.
//
// WHAT THIS SPEC ASSERTS — STRUCTURE, not a pixel count (§12: counts pass on
// broken images):
//
//   (0) PREMISE: the source's maxLevel is BELOW the #2093 ceiling (read out of
//       the engine, never mirrored), so the drape is genuinely the production
//       path here. Without this the gate can go vacuous the day the ceiling or
//       the mirror's maxzoom moves — which is precisely how it just did.
//   (a) the fill PAINTS at overzoom (was fully blank at z16+ pre-fix), with
//       the coast edge in frame (green fraction strictly inside (0.02, 0.98));
//   (b) the MECHANISM is wired: virtual-coord bake keys exist in the drape
//       cache (cut the dispatch and this reddens on any GPU — §12 cause-first);
//   (c) the coast edge is NATIVE-SHARP: ≤20% of edge rows carry a ≥2px soft
//       band. Measured on the re-pointed camera: 0.025 over a 240-row profile.
//       The bound is the original's, unchanged.
//
// Settling is the one deliberate departure from the original: it slept
// `waitForTimeout(6000)`, calibrated for the 14.6 MB countries.geojson compile
// this spec no longer loads, and the capture-canvas skill forbids a sleep for
// content anyway (a sleep that works is a race that has not lost yet). The
// engine's own pending upload/load counters decide instead, a non-zero residual
// FAILS, and the frame comes back chrome-free via `captureMapFrame`.
//
// The window math itself is pinned exactly in vector-drape-overzoom.test.ts;
// this spec proves the wiring end-to-end on the real GPU path.

import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureMapFrame } from './helpers/visual'

const HERE = dirname(fileURLToPath(import.meta.url))

const STYLE = [
  'xgis 1',
  '',
  'source world {',
  '  type: tilejson',
  '  url: "/vendor/demotiles-mirror/tiles/tiles.json"',
  '}',
  '',
  'layer land {',
  '  source: world',
  '  sourceLayer: "countries"',
  '  | fill-emerald-400',
  '}',
].join('\n')

/** The original gate's camera position, verbatim. Only the zoom moved — see the
 *  "WHY 10.3" note in the header. */
const CENTER = { lon: 20.07, lat: 32.17 }
const ZOOM = 10.3

/** Selection zooms at/above this render DIRECT, and the drape this gate exists
 *  to measure never runs. READ FROM THE ENGINE SOURCE, never mirrored: a spec
 *  that hard-codes the ceiling is a second authority for it, and the two drift
 *  silently the day the constant moves (CLAUDE.md §12). The engine module cannot
 *  be imported here — raw-Node spec transpilation does not resolve its
 *  `@xgis/shared` import — so the literal is parsed out of the file instead, and
 *  a parse failure is loud.
 *
 *  Called from the test BODY, never at module scope: a module-scope read that
 *  throws aborts collection for every spec in the suite (#1638). */
function readGlobeDirectMinSelectionZ(): number {
  const src = readFileSync(join(HERE, '../../geo/src/projections-table.ts'), 'utf8')
  const m = /export const GLOBE_DIRECT_MIN_SELECTION_Z = (\d+)/.exec(src)
  if (!m)
    throw new Error('could not read GLOBE_DIRECT_MIN_SELECTION_Z from geo/src/projections-table.ts')
  return Number(m[1])
}

/** Convergence budget. The mirror is 22 tiny local pbf tiles, but the `dark`
 *  demo still compiles its own 14.6 MB countries.geojson at boot before the
 *  inline style replaces it. Measured ~44 s to steady state under SwiftShader;
 *  5 minutes, and a residual FAILS rather than being measured (#2053). */
const DRAIN_BUDGET_MS = 300_000

// File scope so FIXTURE setup is covered, not just the body (§12).
test.describe.configure({ timeout: 900_000 })

type Win = Window & {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisRunSource?: (s: string) => Promise<unknown>
  __xgisMap?: {
    invalidate?: () => void
    setCenter: (lon: number, lat: number) => void
    setZoom: (z: number) => void
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
  maxLevel: number
  bakedCount: number
  virtualBakedCount: number
}

async function dumpSources(page: Page): Promise<Record<string, SourceState>> {
  return page.evaluate(() => {
    const out: Record<string, SourceState> = {}
    const vt = (window as unknown as Win).__xgisMap?.vtSources
    if (vt) {
      for (const [name, entry] of vt) {
        const r = entry.renderer
        const drape = r['_drape'] as { baked?: Map<string, unknown> } | undefined
        const keys = [...(drape?.baked?.keys() ?? [])]
        out[name] = {
          drapeGlobeFills: r['_drapeGlobeFills'] === true,
          maxLevel: entry.source.maxLevel ?? -1,
          bakedCount: keys.length,
          // Virtual-coord keys are `slice:parentKey:z/x/y`; a plain parent bake
          // has no trailing z/x/y.
          virtualBakedCount: keys.filter((k) => /:\d+\/\d+\/\d+$/.test(k)).length,
        }
      }
    }
    return out
  })
}

/** Poll the engine's own pending-work counters instead of sleeping, and
 *  `invalidate()` while they are non-zero so a render-on-demand engine actually
 *  drains rather than idling with a backlog (#2053). */
async function drainUploads(
  page: Page,
  budgetMs: number,
): Promise<{ convergedMs: number; residualUploads: number; residualLoads: number }> {
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

test('#2024 — globe fill drape stays native-sharp past the source maxLevel', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 })

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

  await page.goto('/demo.html?id=dark&proj=globe', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 180_000,
  })
  await page.evaluate(
    async (args) => {
      const w = window as unknown as Win
      await w.__xgisRunSource!(args.style)
      w.__xgisMap!.setCenter(args.lon, args.lat)
      w.__xgisMap!.setZoom(args.zoom)
    },
    { style: STYLE, lon: CENTER.lon, lat: CENTER.lat, zoom: ZOOM },
  )

  const drain = await drainUploads(page, DRAIN_BUDGET_MS)
  expect(
    drain.residualUploads + drain.residualLoads,
    `the engine never converged — ${drain.residualUploads} uploads / ${drain.residualLoads} ` +
      `loads still pending after ${drain.convergedMs}ms. A half-loaded frame is not the ` +
      `converged frame (#2053) and must not be measured as one.`,
  ).toBe(0)

  const backend = await page.evaluate(
    () => (window as unknown as Win).__xgisActiveBackend ?? 'unknown',
  )
  expect(
    backend,
    'the drape is WebGPU-only (vector-tile-renderer.ts:3623), so on WebGL2 this camera renders ' +
      'direct and every assertion below would be measuring the wrong path',
  ).toBe('webgpu')

  const state = await dumpSources(page)
  const names = Object.keys(state)
  expect(names.length, 'no vt source — the inline style never took').toBeGreaterThan(0)
  console.log(`[#2024 overzoom state] ${JSON.stringify(state)}`)

  // ── (0) PREMISE — the drape is the production path at this camera ──────────
  // The #2093 ceiling is SOURCE-CLAMPED, so what decides it is each source's own
  // maxLevel, not the camera zoom. If the mirror ever advertises a deeper max,
  // this camera moves to the direct arm and every assertion below becomes a
  // statement about a path that is not running (#996).
  const GLOBE_DIRECT_MIN_SELECTION_Z = readGlobeDirectMinSelectionZ()
  const aboveCeiling = names.filter((k) => state[k].maxLevel >= GLOBE_DIRECT_MIN_SELECTION_Z)
  expect(
    aboveCeiling.map((k) => `${k}{maxLevel:${state[k].maxLevel}}`),
    `these sources sit at or above the #2093 LOD ceiling (${GLOBE_DIRECT_MIN_SELECTION_Z}), so ` +
      `they render DIRECT and the drape this gate measures does not run for them. The mirror is ` +
      `supposed to advertise maxzoom 2 (/vendor/demotiles-mirror/tiles/tiles.json).`,
  ).toEqual([])
  const draping = names.filter((k) => state[k].drapeGlobeFills)
  expect(
    draping,
    `no source reports _drapeGlobeFills at z${ZOOM} — with every maxLevel below the ceiling the ` +
      `sphere route must bake→drape here. sources: ` +
      names.map((k) => `${k}{maxLevel:${state[k].maxLevel}}`).join(' '),
  ).not.toEqual([])

  // ── (b) CAUSE — the windowed path is ACTIVE (§12: mechanism before effect) ──
  // It is active iff the drape's bake cache holds virtual-coord keys. With the
  // dispatch cut, only plain parent keys exist and this reddens unambiguously on
  // any GPU.
  const virtualBakes = names.reduce((acc, k) => acc + state[k].virtualBakedCount, 0)
  expect(
    virtualBakes,
    'no virtual windowed bakes in the drape cache — the #2024 overzoom dispatch did not engage',
  ).toBeGreaterThan(0)

  // ── (a)/(c) EFFECT — the coast edge ────────────────────────────────────────
  const png = await captureMapFrame(page, { readyTimeoutMs: 180_000, capture: 'clip' })
  const m = await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('img'))
      img.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const w = img.width,
      h = img.height
    const d = ctx.getImageData(0, 0, w, h).data
    const isGreen = (x: number, y: number): boolean => {
      const i = (y * w + x) * 4
      return d[i + 1]! > 120 && d[i + 1]! > d[i]! + 30 && d[i + 1]! > d[i + 2]! + 10
    }
    let green = 0
    let n = 0
    for (let y = 40; y < h - 40; y++) {
      for (let x = 0; x < w; x++) {
        n++
        if (isGreen(x, y)) green++
      }
    }
    // Per-row soft-band width across the black→green coast transition: the
    // count of intermediate-green pixels (20 < G < 120) hugging the first
    // green pixel. A native-density bake gives ≈1 px; the parent-magnified
    // bake gives ≈2^(zoom − maxLevel) px.
    const widths: number[] = []
    for (let y = 120; y < h - 120; y += 2) {
      let firstGreen = -1
      for (let x = 2; x < w - 2; x++) {
        if (isGreen(x, y)) {
          firstGreen = x
          break
        }
      }
      if (firstGreen < 4) continue
      let soft = 0
      for (let x = firstGreen - 1; x >= 0; x--) {
        const i = (y * w + x) * 4
        const g = d[i + 1]!
        if (g > 20 && g < 120) soft++
        else break
      }
      widths.push(soft)
    }
    // Robust discriminator: on a diagonal edge the per-row soft band alternates
    // with the stair phase, so a bare median rides the 1↔2 boundary. The
    // FRACTION of rows whose band is ≥ 2 px separates cleanly: ≈0.03 for the
    // native-density windowed bake here, and → 1.0 for a parent-magnified bake
    // at this Δz.
    const wide = widths.filter((v) => v >= 2).length
    const fracWide = widths.length > 0 ? wide / widths.length : 1
    URL.revokeObjectURL(url)
    return { greenFrac: green / n, fracWide, rows: widths.length }
  }, Array.from(png))
  console.log(`[#2024 overzoom coast] ${JSON.stringify(m)}`)

  expect(errors, `pageerrors: ${errors.join(' | ')}`).toHaveLength(0)
  // (a) paints at overzoom, coast in frame. Pre-fix the drape drew NOTHING
  // past the source max, or only the magnified parent bake.
  expect(m.greenFrac, 'coast edge must be in frame with land painted').toBeGreaterThan(0.02)
  expect(m.greenFrac, 'coast edge must be in frame (not all-land)').toBeLessThan(0.98)
  expect(m.rows, 'edge profile must sample enough rows').toBeGreaterThan(50)
  // (c) native sharpness — a parent-magnified bake at Δz 8.3 measures ≈1.0 here.
  expect(
    m.fracWide,
    `fraction of coast rows with a ≥2px soft band = ${m.fracWide.toFixed(3)} — the windowed bake ` +
      `measures 0.025 over a 240-row profile at this camera; a parent-magnified bake at Δz 8.3 ` +
      `saturates the metric. Bound unchanged from the pre-#2093 camera.`,
  ).toBeLessThanOrEqual(0.2)
})
