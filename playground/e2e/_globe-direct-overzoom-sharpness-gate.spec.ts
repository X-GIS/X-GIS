// ═══ #2093 — the #2024 deep-zoom scenario, after the LOD ceiling ═══
//
// `_globe-drape-overzoom-gate.spec.ts` pinned the #2024 fix at z15.3 over the
// Benghazi coast: past the source maxLevel the drape must bake VIRTUAL windowed
// sub-tiles instead of magnifying one 512px parent bake. That gate asserts the
// DRAPE is wired, and it is still the right gate for every route that drapes.
//
// #2093 moves this camera out from under it. `currentZ` is maxLevel-clamped, the
// countries source's maxLevel is ≥ 10, so at z15.3 the frame is at or above
// `GLOBE_DIRECT_MIN_SELECTION_Z` and the route renders DIRECT — the drape, and
// with it the whole windowed-overzoom mechanism, no longer runs here at all.
// Nothing in the old gate notices that: `_drapeGlobeFills` false makes its
// virtual-bake-keys cause assertion red, so this file states the post-#2093
// world for the SAME camera class instead, and the #2024 gate keeps owning the
// sub-ceiling routes it still describes.
//
// Style + camera are the original's, verbatim, so the two gates are statements
// about one scenario and not two. What changes is the claim:
//
//   CAUSE   `_drapeGlobeFills === false` — direct, because the source's maxLevel
//           puts currentZ at/above the ceiling. If the runtime maxLevel is ≤ 9
//           the ceiling cannot be reached from this camera and the spec SKIPS,
//           naming that: a vacuous pass would be #996 all over again.
//           PER SOURCE, not across sources: the ceiling is SOURCE-CLAMPED, and
//           this scene carries a second, synthetic `world__polar_cap` source at
//           maxLevel 0 that KEEPS the drape at every camera zoom — by the
//           derivation, not against it. Every assertion here is therefore scoped
//           to the sources whose own maxLevel reaches the ceiling. That scoping
//           is load-bearing twice over: unscoped, the CAUSE accuses the fix of
//           doing what it documents, and the SEVER arm below becomes vacuous
//           (the polar cap drapes in both arms, so "some source drapes" is true
//           whether or not the override is wired).
//   EFFECT  the coast soft-band metric the original gate defined, held to the
//           bound the original used for the WINDOWED bake (0.20). The direct
//           path magnifies geometry, so it must be at least as sharp as the
//           sharpest bake — a weaker bound here would let a regression through.
//   SEVER   `__XGIS_FORCE_VECTOR_DRAPE` on the same page, same camera. The
//           assertion is RELATIVE — drape strictly softer than direct — because
//           what has to be true is that the two arms are DISTINGUISHABLE; an
//           absolute bound on the drape arm would be re-asserting #2024's number
//           in #2093's gate, and would go red for #2024's reasons.
//
// Settling is the one deliberate departure: the original slept `waitForTimeout
// (6000)`, which the capture-canvas skill forbids for content (a sleep that
// works is a race that has not lost yet). Here the engine's own pending
// upload/load counters decide, and a non-zero residual FAILS.

import { test, expect, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureMapFrame } from './helpers/visual'

const HERE = dirname(fileURLToPath(import.meta.url))

// Verbatim from _globe-drape-overzoom-gate.spec.ts — same source, same layer,
// same fill, so the coast profile below measures the same edge it did.
const STYLE = [
  'xgis 1',
  '',
  'source world {',
  '  type: geojson',
  '  url: "countries.geojson"',
  '}',
  '',
  'layer land {',
  '  source: world',
  '  | fill-emerald-400',
  '}',
].join('\n')

/** The original gate's camera: Benghazi coast, z15.3 — an east-west land-south
 *  coastline, so the coast edge stays in frame under the per-GPU vs_tile
 *  transcendental displacement (#2025). */
const CENTER = { lon: 20.07, lat: 32.17 }
const ZOOM = 15.3

/** Selection zooms below this keep the bake→drape. A source whose maxLevel
 *  clamps currentZ under it can never reach the direct path from any camera —
 *  a valid engine state, not a failure, so the spec skips rather than asserting
 *  into it.
 *
 *  READ FROM THE ENGINE SOURCE, never mirrored: a spec that hard-codes the
 *  ceiling is a second authority for it, and the two drift silently the day the
 *  constant moves (CLAUDE.md §12). The engine module cannot be imported here —
 *  raw-Node spec transpilation does not resolve its `@xgis/shared` import — so
 *  the literal is parsed out of the file instead, and a parse failure is loud.
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

/** The original gate's windowed-bake bound. The direct path is sharper than any
 *  bake by construction (it magnifies geometry, not texels), so holding it to
 *  the sharpest bake's number is the honest floor. */
const SOFT_BAND_MAX = 0.2
/** Convergence budget: the `dark` demo compiles a 14.6 MB countries.geojson
 *  before the first tile can draw (measured ~32 s to steady state under
 *  SwiftShader in `_globe-dateline-wired-gate`), and this style then loads its
 *  own copy. 5 minutes, and a residual FAILS rather than being measured. */
const DRAIN_BUDGET_MS = 300_000

// File scope so FIXTURE setup is covered, not just the body (§12).
test.describe.configure({ timeout: 1_200_000 })

type Win = Window & {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __XGIS_FORCE_VECTOR_DRAPE?: boolean
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
  drapeStrokes: boolean
  maxLevel: number
  bakedCount: number
  virtualBakedCount: number
}
interface CoastProfile {
  greenFrac: number
  fracWide: number
  rows: number
}

// Drape-state introspection recipe from _globe-drape-overzoom-gate.spec.ts:136-149,
// with `maxLevel` added because it is what decides which side of the #2093
// ceiling this camera lands on.
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
          drapeStrokes: r['_drapeStrokes'] === true,
          maxLevel: entry.source.maxLevel ?? -1,
          bakedCount: keys.length,
          virtualBakedCount: keys.filter((k) => /:\d+\/\d+\/\d+$/.test(k)).length,
        }
      }
    }
    return out
  })
}

// Poll the engine's own pending-work counters instead of sleeping, and
// `invalidate()` while they are non-zero so a render-on-demand engine actually
// drains rather than idling with a backlog (#2053). Same shape as the INC-1
// probe's drainUploads and measure-harness's converge().
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

/**
 * The original gate's coast profile, unchanged in substance (only the PNG now
 * arrives as base64 rather than a byte array, and the frame is chrome-free):
 * per row, the count of intermediate-green pixels hugging the first green pixel
 * of the black→green coast transition, reported as the FRACTION of rows whose
 * band is ≥ 2 px. That fraction, not a bare median, is the discriminator — on a
 * diagonal edge the per-row band alternates with the stair phase and a median
 * rides the 1↔2 boundary.
 */
async function coastProfile(page: Page, png: Buffer): Promise<CoastProfile> {
  return page.evaluate(async (b64) => {
    const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
    const bmp = await createImageBitmap(blob)
    const off = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const w = bmp.width
    const h = bmp.height
    const d = ctx.getImageData(0, 0, w, h).data
    const isGreen = (x: number, y: number): boolean => {
      const i = (y * w + x) * 4
      return d[i + 1] > 120 && d[i + 1] > d[i] + 30 && d[i + 1] > d[i + 2] + 10
    }
    let green = 0
    let n = 0
    for (let y = 40; y < h - 40; y++) {
      for (let x = 0; x < w; x++) {
        n++
        if (isGreen(x, y)) green++
      }
    }
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
        const g = d[(y * w + x) * 4 + 1]
        if (g > 20 && g < 120) soft++
        else break
      }
      widths.push(soft)
    }
    const wide = widths.filter((v) => v >= 2).length
    return {
      greenFrac: green / n,
      fracWide: widths.length > 0 ? wide / widths.length : 1,
      rows: widths.length,
    }
  }, png.toString('base64'))
}

test('#2093 — the #2024 overzoom camera renders DIRECT, and stays sharper than the drape', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 720 })

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

  // Boot exactly as the #2024 gate does — same demo, same projection, same
  // in-page style push, same camera.
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
    'the drape is WebGPU-only (vector-tile-renderer.ts:3623), so on WebGL2 BOTH arms below ' +
      'render direct and the sever arm cannot distinguish anything',
  ).toBe('webgpu')

  // ── CAUSE — direct, and only because the ceiling is reachable here ─────────
  const direct = await dumpSources(page)
  const names = Object.keys(direct)
  expect(names.length, 'no vt source — the inline style never took').toBeGreaterThan(0)

  const maxLevel = Math.max(...names.map((k) => direct[k].maxLevel))
  const GLOBE_DIRECT_MIN_SELECTION_Z = readGlobeDirectMinSelectionZ()
  test.skip(
    maxLevel < GLOBE_DIRECT_MIN_SELECTION_Z,
    `source maxLevel ${maxLevel} clamps currentZ below GLOBE_DIRECT_MIN_SELECTION_Z ` +
      `(${GLOBE_DIRECT_MIN_SELECTION_Z}), so this camera can never reach the #2093 direct ` +
      `path and the assertions below would be vacuous. The drape — and its #2024 windowed ` +
      `overzoom — correctly still owns this route; _globe-drape-overzoom-gate covers it.`,
  )

  // PER SOURCE, not across sources. The ceiling is SOURCE-CLAMPED (currentZ is
  // `min(floor(cameraZoom), source.maxLevel)` — projections-table.ts:309-313), so
  // only a source whose OWN maxLevel reaches it can go direct at this camera. The
  // `dark` demo also carries a synthetic `world__polar_cap` at maxLevel 0, which
  // therefore KEEPS the drape at every camera zoom — that is the derivation
  // working, not failing, and judging it against the direct claim accuses the fix
  // of doing exactly what it documents. The scalar `maxLevel` above only decides
  // whether ANY source can reach the ceiling (the skip); every assertion below is
  // scoped to the sources that actually do.
  const ceilingReaching = names.filter((k) => direct[k].maxLevel >= GLOBE_DIRECT_MIN_SELECTION_Z)
  expect(
    ceilingReaching,
    `no source here has maxLevel ≥ ${GLOBE_DIRECT_MIN_SELECTION_Z}, so nothing below would be a ` +
      `statement about the ceiling. sources: ` +
      names.map((k) => `${k}{maxLevel:${direct[k].maxLevel}}`).join(' '),
  ).not.toEqual([])

  const stillDraping = ceilingReaching.filter((k) => direct[k].drapeGlobeFills)
  expect(
    stillDraping.map(
      (k) =>
        `${k}{maxLevel:${direct[k].maxLevel},strokes:${direct[k].drapeStrokes},` +
        `baked:${direct[k].bakedCount}}`,
    ),
    `these sources still bake→drape at z${ZOOM} with maxLevel ≥ ${GLOBE_DIRECT_MIN_SELECTION_Z}. ` +
      `The #2093 LOD ceiling (geo/src/projections-table.ts:305, wired at ` +
      `vector-tile-renderer.ts:3615) did not engage.`,
  ).toEqual([])

  // ── EFFECT — the coast edge, on the original gate's own metric ─────────────
  const directPng = await captureMapFrame(page, { readyTimeoutMs: 180_000, capture: 'clip' })
  writeFileSync(test.info().outputPath('direct.png'), directPng)
  const directProfile = await coastProfile(page, directPng)
  console.log(`[#2093 overzoom direct] ${JSON.stringify(directProfile)}`)

  // The original gate's framing guards, kept: a frame with no coast in it has
  // nothing to measure, and both bounds below would pass on it.
  expect(directProfile.greenFrac, 'coast edge must be in frame with land painted').toBeGreaterThan(
    0.02,
  )
  expect(directProfile.greenFrac, 'coast edge must be in frame (not all-land)').toBeLessThan(0.98)
  expect(directProfile.rows, 'edge profile must sample enough rows').toBeGreaterThan(50)
  expect(
    directProfile.fracWide,
    `fraction of coast rows with a ≥2px soft band on the DIRECT path = ` +
      `${directProfile.fracWide.toFixed(3)}. The #2024 windowed bake measured 0.12 here and the ` +
      `parent-magnified bake 0.31; the direct path magnifies geometry rather than texels, so it ` +
      `must clear the windowed bake's own bound.`,
  ).toBeLessThanOrEqual(SOFT_BAND_MAX)

  // ── SEVER — hold the drape on the same page, same camera ───────────────────
  // Live toggle, not a second page: two simultaneous WebGPU contexts livelocked
  // SwiftShader in the INC-1 probe. `_drapeGlobeFills` is recomputed every render
  // call, so flipping the global + forcing a repaint takes effect immediately
  // (the `_globe-vector-drape-i2` / `_globe-vector-line-drape` idiom).
  await page.evaluate(() => {
    ;(globalThis as { __XGIS_FORCE_VECTOR_DRAPE?: boolean }).__XGIS_FORCE_VECTOR_DRAPE = true
    ;(window as unknown as Win).__xgisMap?.invalidate?.()
  })
  const drapeDrain = await drainUploads(page, DRAIN_BUDGET_MS)
  expect(
    drapeDrain.residualUploads + drapeDrain.residualLoads,
    `the drape arm never converged — ${drapeDrain.residualUploads} uploads / ` +
      `${drapeDrain.residualLoads} loads pending after ${drapeDrain.convergedMs}ms`,
  ).toBe(0)

  const draped = await dumpSources(page)
  // Scoped to `ceilingReaching` for the same reason the CAUSE was, but here the
  // scoping is what gives the assertion any information at all: the sub-ceiling
  // `world__polar_cap` drapes in BOTH arms, so an unscoped "some source drapes"
  // is true whether or not the override is wired, and would green a severed
  // lever (§12 — an assertion must DISTINGUISH the states it tests).
  const drapingNow = ceilingReaching.filter((k) => draped[k]?.drapeGlobeFills)
  expect(
    drapingNow,
    `__XGIS_FORCE_VECTOR_DRAPE is set but no source ABOVE the ceiling reports _drapeGlobeFills — ` +
      `the override at vector-tile-renderer.ts:3621 is not wired, so the two arms below are the ` +
      `same arm and the comparison proves nothing. above-ceiling sources: ` +
      ceilingReaching
        .map(
          (k) =>
            `${k}{fills:${draped[k]?.drapeGlobeFills},baked:${draped[k]?.bakedCount},` +
            `virtual:${draped[k]?.virtualBakedCount}}`,
        )
        .join(' '),
  ).not.toEqual([])
  const bakedTotal = ceilingReaching.reduce((acc, k) => acc + (draped[k]?.bakedCount ?? 0), 0)
  expect(
    bakedTotal,
    'the drape flag is on but the bake cache is empty — nothing was baked, so a softer coast ' +
      'below would not be the drape',
  ).toBeGreaterThan(0)

  const drapedPng = await captureMapFrame(page, { readyTimeoutMs: 180_000, capture: 'clip' })
  writeFileSync(test.info().outputPath('draped.png'), drapedPng)
  const drapedProfile = await coastProfile(page, drapedPng)
  console.log(`[#2093 overzoom draped] ${JSON.stringify(drapedProfile)}`)

  expect(drapedProfile.rows, 'drape arm edge profile must sample enough rows').toBeGreaterThan(50)
  // RELATIVE, deliberately: the claim is that the ceiling changes what is drawn,
  // i.e. that the arms are distinguishable. An absolute bound here would restate
  // #2024's windowed-bake number inside #2093's gate.
  expect(
    drapedProfile.fracWide,
    `soft-band fraction: direct ${directProfile.fracWide.toFixed(3)} vs drape-held ` +
      `${drapedProfile.fracWide.toFixed(3)}. Equal means holding the drape changed nothing at ` +
      `this camera — the #2093 ceiling is then not the mechanism that decides sharpness here, ` +
      `which is a finding about the fix, not a flake.`,
  ).toBeGreaterThan(directProfile.fracWide)

  // Leave the page as it was found — the flag is on globalThis and a later
  // navigation in the same context would inherit it.
  await page.evaluate(() => {
    delete (globalThis as { __XGIS_FORCE_VECTOR_DRAPE?: boolean }).__XGIS_FORCE_VECTOR_DRAPE
  })

  expect(errors, `pageerrors: ${errors.join(' | ')}`).toHaveLength(0)
})
