// #1253 — LAYER-WIDE translucent-extrude shell: the cross-tile double-blend witness.
//
// THE BUG (fixed by this branch): #1080's front shell — a depth prepass then a
// depth-`less-equal` colour pass with depth write off — runs per DRAW, and a
// draw is one TILE. Two translucent extruded features in DIFFERENT tiles that
// overlap on screen therefore each ran their own prepass+colour pair, and the
// shared pixel was blended TWICE (visibly darker / more opaque). The fix routes
// the layer to a shell pass that draws its WHOLE tile set into one offscreen
// colour target with blending OFF, then composites once.
//
// THE ASSERTION, and why it needs no colour model. Render three frames from the
// same camera:
//
//     FA  — feature A alone       FB  — feature B alone       FAB — both
//
// Wherever A and B overlap on screen, exactly ONE of them is in front. So under
// the fix FAB(p) must equal FA(p) or FB(p) at every overlap pixel — whichever
// surface won the depth test — and under the bug it equals NEITHER, because it
// is a blend of both. That is the issue's acceptance ("overlap region is the
// SAME opacity as a non-overlap region") stated pixel-wise, and it is
// self-calibrating: no baseline image, no assumed background, no assumed wall
// shading, and no hard-coded sample coordinates.
//
// NON-VACUITY comes first and is independent of the fix: |A ∩ B| is measured
// from FA and FB and must exceed a floor. A camera that produces no overlap
// would make the main assertion trivially true, which is exactly the shape §12
// calls a worthless gate — so a small overlap FAILS with the measurement in the
// message rather than passing quietly.
//
// CONTROL: the same three frames at opacity 1. Opaque extrusions never entered
// the shell bucket, so the identity must hold there before AND after — a
// regression that broke opaque extrusion depth ordering shows up here.
//
// Two arms: flat (mercator, pitched, so the far feature's tower projects over
// the near one) and globe (where the issue reports neighbouring walls crossing
// on the limb).
//
// UNREGISTERED PROBE (`_`-prefixed, not in any workflow): the geometry +
// camera constants below decide whether an overlap exists at all, and they are
// the knobs to calibrate against a real run. Every failure prints the measured
// mask sizes so the calibration is one edit, not a hunt.

import { test, expect, type Page } from '@playwright/test'

// ── Scene constants (the calibration knobs) ────────────────────────
//
// `globe_extrusion` is the host demo: its `towers` layer takes a PER-FEATURE
// height (`fill-extrusion-height-[.POP_EST / 4000]`), which is what lets a
// pushed FeatureCollection choose its own tower height, and its `countries`
// source is a plain geojson source so `setSourceData` replaces it wholesale.
const DEMO = 'globe_extrusion'
// z=5 tile boundary: lon = -180 + 360·x/2^5 lands on 0° at x = 16. A and B sit
// either side of it, so they compile into ADJACENT tiles — the case #1080's
// per-draw shell cannot see.
const TILE_BOUNDARY_LON = 0
const LAT0 = 10
const LAT1 = 14
// POP_EST / 4000 metres ⇒ 1.2e9 is a ~300 km tower, the band the demo's own
// header calls out as visible at globe framing.
const POP_EST = 1.2e9
const OPACITY = 0.5
/** Overlap floor: below this the camera produced no cross-tile overlap and the
 *  main assertion would be vacuous. */
const MIN_OVERLAP_PX = 400
/** Per-channel tolerance for "this pixel matches that pixel". Generous enough
 *  for the software rasteriser's edge dithering, far tighter than one blend:
 *  a second blend at OPACITY moves a channel by ~0.5 × the fill/background gap. */
const MATCH_TOL = 12

type XMap = {
  setSourceData(id: string, fc: unknown): void
  setProjection(name: string): void
  getLayer(name: string): { style: { opacity: number; stroke: string | null } } | null
  getCamera(): { centerX: number; centerY: number; zoom: number; bearing: number; pitch: number }
  markCameraPositioned(): void
  invalidate?(): void
}

function box(west: number, east: number): unknown {
  return {
    type: 'Feature',
    properties: { POP_EST },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [west, LAT0],
          [east, LAT0],
          [east, LAT1],
          [west, LAT1],
          [west, LAT0],
        ],
      ],
    },
  }
}

// A is WEST of the boundary, B is EAST of it. They do not touch in ground
// space; the overlap is created by the towers projecting over one another.
const FEATURE_A = box(TILE_BOUNDARY_LON - 3.6, TILE_BOUNDARY_LON - 0.4)
const FEATURE_B = box(TILE_BOUNDARY_LON + 0.4, TILE_BOUNDARY_LON + 3.6)

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
}

/** Push one feature set and capture the canvas once the tile queue is idle. */
async function frameFor(page: Page, features: unknown[], opacity: number): Promise<Buffer> {
  await page.evaluate(
    ({ features, opacity }) => {
      const m = (window as unknown as { __xgisMap: XMap }).__xgisMap
      // The ocean backdrop is irrelevant to the claim and its own fills would
      // sit under the towers; empty it so the frames differ ONLY in the towers.
      m.setSourceData('ocean', { type: 'FeatureCollection', features: [] })
      m.setSourceData('countries', { type: 'FeatureCollection', features })
      const towers = m.getLayer('towers')
      if (towers) {
        towers.style.opacity = opacity
        // Drop the outline: a stroke is drawn by the LINE pipeline, never
        // enters the shell bucket, and would put a third colour into the
        // overlap region for no benefit to the claim.
        towers.style.stroke = null
      }
      m.invalidate?.()
    },
    { features, opacity },
  )
  await page.waitForTimeout(2_500)
  return await page.locator('#map').screenshot()
}

interface Rgba {
  w: number
  h: number
  d: Uint8ClampedArray
}

/** Decode the three PNGs in the page and run the whole comparison there — the
 *  pixel loops need a canvas, and shipping three full frames back over the
 *  protocol as base64 is the slow way to get the same four numbers. */
async function compare(
  page: Page,
  a: Buffer,
  b: Buffer,
  ab: Buffer,
): Promise<{ maskA: number; maskB: number; overlap: number; mismatched: number }> {
  return await page.evaluate(
    async ({ a, b, ab, tol }) => {
      const decode = (b64: string): Promise<Rgba> =>
        new Promise((res) => {
          const img = new Image()
          img.onload = () => {
            const c = document.createElement('canvas')
            c.width = img.width
            c.height = img.height
            const ctx = c.getContext('2d', { willReadFrequently: true })!
            ctx.drawImage(img, 0, 0)
            const im = ctx.getImageData(0, 0, c.width, c.height)
            res({ w: c.width, h: c.height, d: im.data })
          }
          img.src = `data:image/png;base64,${b64}`
        })
      const [FA, FB, FAB] = await Promise.all([decode(a), decode(b), decode(ab)])
      // "This feature covers this pixel" = FA differs from the empty-scene
      // background at that pixel. The background is whatever the style paints,
      // so it is taken from FA's own top-left corner rather than assumed.
      const bg = [FA.d[0], FA.d[1], FA.d[2]]
      const near = (p: Uint8ClampedArray, i: number, q: number[], t: number): boolean =>
        Math.abs(p[i] - q[0]) <= t && Math.abs(p[i + 1] - q[1]) <= t && Math.abs(p[i + 2] - q[2]) <= t
      const sameAt = (p: Uint8ClampedArray, q: Uint8ClampedArray, i: number, t: number): boolean =>
        Math.abs(p[i] - q[i]) <= t &&
        Math.abs(p[i + 1] - q[i + 1]) <= t &&
        Math.abs(p[i + 2] - q[i + 2]) <= t
      let maskA = 0
      let maskB = 0
      let overlap = 0
      let mismatched = 0
      for (let i = 0; i < FA.d.length; i += 4) {
        const inA = !near(FA.d, i, bg, 6)
        const inB = !near(FB.d, i, bg, 6)
        if (inA) maskA++
        if (inB) maskB++
        if (!inA || !inB) continue
        overlap++
        // The claim: whichever feature won the depth test at this pixel, the
        // combined frame shows THAT surface — not a blend of both.
        if (!sameAt(FAB.d, FA.d, i, tol) && !sameAt(FAB.d, FB.d, i, tol)) mismatched++
      }
      return { maskA, maskB, overlap, mismatched }
    },
    { a: a.toString('base64'), b: b.toString('base64'), ab: ab.toString('base64'), tol: MATCH_TOL },
  )
}

async function runArm(page: Page, projection: string, hash: string): Promise<void> {
  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto(`/demo.html?id=${DEMO}&e2e=1${hash}`, { waitUntil: 'domcontentloaded' })
  await ready(page)
  await page.evaluate((p) => {
    ;(window as unknown as { __xgisMap: XMap }).__xgisMap.setProjection(p)
  }, projection)
  await page.waitForTimeout(1_500)

  for (const opacity of [OPACITY, 1]) {
    const label = opacity === 1 ? 'opaque control' : 'translucent'
    const fa = await frameFor(page, [FEATURE_A], opacity)
    const fb = await frameFor(page, [FEATURE_B], opacity)
    const fab = await frameFor(page, [FEATURE_A, FEATURE_B], opacity)
    const r = await compare(page, fa, fb, fab)
    console.log(`[#1253 ${projection} ${label}]`, JSON.stringify(r))

    // Non-vacuity FIRST (§12: assert the CAUSE before the EFFECT). Without a
    // real overlap the identity below cannot fail, so a thin overlap must read
    // as a calibration failure, not as a pass.
    expect(
      r.overlap,
      `[${projection} ${label}] the two features do not overlap on screen ` +
        `(maskA=${r.maskA}, maskB=${r.maskB}, overlap=${r.overlap}) — recalibrate the ` +
        `camera / tower height so a cross-tile overlap exists, or this gate proves nothing`,
    ).toBeGreaterThan(MIN_OVERLAP_PX)

    // The witness. Under the per-tile front shell every overlap pixel is a
    // blend of BOTH features and therefore matches neither single-feature
    // frame, so this is ~100 % of `overlap` before the fix and ~0 % after.
    const ratio = r.mismatched / r.overlap
    expect(
      ratio,
      `[${projection} ${label}] ${r.mismatched}/${r.overlap} overlap pixels match NEITHER ` +
        `single-feature frame — the overlap is being blended twice (#1253)`,
    ).toBeLessThan(0.02)
  }
}

test.describe('#1253 — cross-tile translucent extrusion blends once', () => {
  test.describe.configure({ timeout: 180_000 })

  test('flat: adjacent-tile towers overlapping at pitch', async ({ page }) => {
    // Pitched and looking east, so the EAST feature's tower projects up over
    // the WEST one — two tiles, one screen region.
    await runArm(page, 'mercator', '#5/12/0/90/70')
  })

  test('globe: adjacent-tile towers crossing near the limb', async ({ page }) => {
    await runArm(page, 'globe', '#3/12/0/0/0')
  })
})
