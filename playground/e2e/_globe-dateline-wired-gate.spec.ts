// Regression guard for fix(globe) commit 3eb9c11. Before the wire-in,
// production VTR used visibleTilesSSE / visibleTilesFrustum which
// don't understand sphere visibility — globe at the antimeridian
// (#2/0/180) rendered an almost-empty sphere because the mercator
// selectors only picked tiles near the camera's mercator-x position.
// PR #138 added `globeVisibleTiles` but the function had no
// production caller. This spec pins the wire-in by asserting the
// far-hemisphere geometry (Pacific landmass — Australia + NZ +
// Indonesia + Eastern Russia limb) actually paints when the camera
// faces lon=180.
//
// ─── #1774 — the pixel count alone did not pin the mechanism ─────────────
// Measured 2026-08-17 while gating PR #1771: forcing `routeToSphereSelector()`
// (geo/src/projections-table.ts:223) to unconditionally `return false` — the
// exact pre-wire-in state this spec exists to catch — left the dark-fill
// pixel COUNT below unchanged and the spec still PASSED (13.9 s). This is
// CLAUDE.md §12's "assertion that failed either way": severing the specific
// mechanism must change the verdict, or no premise fix can ever be proven by
// the gate. It was also registered in no CI leg (a #1349-class dark gate).
//
// Why the pixel count alone couldn't tell: with routeToSphereSelector
// severed, a `globeMode` camera still falls through the `else` branch of
// tile-selection-cache.ts's selector dispatch and calls `visibleTilesSSE` —
// the FLAT mercator selector. globe (projType 7) is non-periodic
// (`worldCopies: SINGLE_WORLD`, geo/src/projections-table.ts), so that flat
// path runs a SINGLE world copy with no antimeridian wraparound
// (data/src/tiles-sse.ts's own header lists "World-copy enumeration (camera
// spanning antimeridian)" as explicitly NOT implemented there). Concretely,
// at lon=180 its per-corner world-copy shift
// (`wo = floor((lonAbs - camLon + 180) / 360)`) computes `wo=0` for the
// z-level tile touching lon=180 from the west (wrapped x = 2^z−1) but
// `wo=-1` — a FULL CIRCUMFERENCE away — for the tile touching lon=-180 from
// the east (wrapped x = 0), so only one side of the seam ever lands on
// screen; the other is pushed tens of thousands of km off-canvas and culled.
// `globeVisibleTiles` (data/src/globe-visible-tiles.ts) has no such split:
// it tests visibility in continuous lon/lat→sphere space, so a camera
// centred on the antimeridian keeps tiles on BOTH x≈0 and x≈(2^z−1) at the
// same z — literally the "Pacific hemisphere" content this spec's pixel
// count was written to catch, just observed one layer upstream, at
// selection time instead of at paint time.
//
// The discriminator below reads the LIVE selected tile set via
// `window.__xgisSnapshot().sources.world.tiles` (map/src/diagnostics.ts,
// `world` is dark.xgis's geojson source name) and asserts that some
// selected zoom level carries tiles at BOTH the wrapped-x minimum (x=0) and
// the wrapped-x maximum (x=2^z−1) at once — a structural split the flat
// selector cannot produce (derivation above), so unlike the raw pixel count
// it goes RED when routeToSphereSelector is severed. It is asserted (the
// CAUSE) BEFORE the pixel check (the EFFECT) per §12: order decides which
// assertion names the real break.
//
// Sever-probe that closes #1774: force `routeToSphereSelector`
// (geo/src/projections-table.ts:223) to `return false` unconditionally →
// this spec's tile-set assertion must go RED, naming "no z level had tiles
// on both x=0 and x=(tileN-1)" — not a pixel-count message. Restore and it
// is green again.

import { test, expect } from '@playwright/test'

// Dark-fill pixels required before the far hemisphere counts as painted.
// Australia + NZ alone contribute many thousand; the threshold sits well
// above any noise / AA bleed.
const DARK_FILL_MIN = 1000

interface Snapshot {
  sources: Record<string, { tiles: Array<{ z: number; x: number; y: number }> }>
}

/** True when some selected zoom level (z ≥ 1 — the trivial single-tile z=0
 *  root would otherwise trivially satisfy "both sides" against itself)
 *  carries a tile at the wrapped-x MINIMUM (x=0, touching lon=-180) and a
 *  tile at the wrapped-x MAXIMUM (x=2^z−1, touching lon=+180)
 *  simultaneously — the antimeridian-straddling tile set only the
 *  sphere-aware selector can produce (see file-header derivation).
 *  Returns a diagnostic dump of every z-group's x-set either way, so a
 *  failure message names exactly what WAS selected instead of just "false". */
function findBothAntimeridianSides(tiles: Array<{ z: number; x: number; y: number }>): {
  found: boolean
  detail: string
} {
  const byZ = new Map<number, Set<number>>()
  for (const t of tiles) {
    if (t.z < 1) continue
    if (!byZ.has(t.z)) byZ.set(t.z, new Set())
    byZ.get(t.z)!.add(t.x)
  }
  for (const [z, xs] of byZ) {
    const tileN = Math.pow(2, z)
    if (xs.has(0) && xs.has(tileN - 1)) {
      return { found: true, detail: `z=${z} has tiles at x=0 AND x=${tileN - 1} (tileN=${tileN})` }
    }
  }
  const dump = [...byZ.entries()]
    .map(([z, xs]) => `z${z}:[${[...xs].sort((a, b) => a - b).join(',')}]`)
    .join(' ')
  return {
    found: false,
    detail: `no z level had tiles on both x=0 and x=(tileN-1); selected: ${dump || '(none)'}`,
  }
}

test('globe @ dateline renders the Pacific hemisphere', async ({ page }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1024, height: 720 })
  await page.goto('/demo.html?id=dark&proj=globe#2/0/180', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 15_000 },
  )

  // Australia + NZ + Indonesia + Pacific island chains land in the
  // central + lower half of the canvas when looking at lon=180 / lat=
  // 0. Count slate-700-class fill pixels (dark.xgis renders countries
  // with `fill-slate-800 stroke-cyan-400`); slate-800 RGB ≈ (30,41,59).
  // Tolerance is loose because MSAA + log-depth blend dim it a little.
  const sampleDarkFill = async (): Promise<number> => {
    const png = await page.locator('#map').screenshot({ type: 'png' })
    return page.evaluate(async (bytes) => {
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
      const data = ctx.getImageData(0, 0, w, h).data
      // Central 60×60% region — excludes UI chrome (zoom badge top-
      // left, snapshot button top-right, status bar bottom).
      const xMin = Math.floor(w * 0.2),
        xMax = Math.floor(w * 0.8)
      const yMin = Math.floor(h * 0.2),
        yMax = Math.floor(h * 0.8)
      let darkFill = 0
      for (let y = yMin; y < yMax; y++) {
        for (let x = xMin; x < xMax; x++) {
          const i = (y * w + x) * 4
          const r = data[i]!,
            g = data[i + 1]!,
            b = data[i + 2]!
          // slate-700/800 family: low-saturation cool grey. r<70, g 30-80,
          // b 40-90 covers MSAA-blended variants of the slate fill.
          if (r < 70 && g >= 30 && g < 90 && b >= 40 && b < 100) darkFill++
        }
      }
      URL.revokeObjectURL(url)
      return darkFill
    }, Array.from(png))
  }

  // Poll rather than sample once at a fixed delay. `__xgisReady` fires when the
  // map is live, NOT when it has painted: measured on the software rasterizer
  // (XGIS_SOFTWARE_GPU=1) this page reports ready at ~3 s and the canvas is
  // still ENTIRELY unpainted — not merely fill-less, zero non-background pixels
  // in the sampled region — at +6 s and +9 s, reaching its steady 6.6k dark-fill
  // px only around +35 s, because the `dark` demo compiles a 14.6 MB
  // countries.geojson before the first tile can draw. The former fixed
  // `waitForTimeout(2500)` therefore read the frame before anything existed and
  // reported 0, a coin-flip that fails on origin/main as readily as on any
  // branch (measured 4 of 6 runs at merge-base e44611b8).
  //
  // This does NOT weaken the gate: the threshold below is unchanged, the loop
  // never breaks under it, and a hemisphere that genuinely does not paint stays
  // at 0 for the whole budget and still fails — it only stops the spec
  // concluding "empty" from a frame that had not been rendered yet.
  const deadline = Date.now() + 120_000
  let dark = 0
  for (;;) {
    dark = await sampleDarkFill()
    if (dark > DARK_FILL_MIN || Date.now() > deadline) break
    await page.waitForTimeout(1000)
  }

  // ─── CAUSE — the selected tile set, asserted BEFORE the pixel effect ────
  // (#1774 / §12: order decides which assertion names the real break.) Read
  // the same settled frame the pixel sample above just measured.
  const snap = (await page.evaluate(async () => {
    const w = window as unknown as { __xgisSnapshot?: () => Promise<unknown> }
    return w.__xgisSnapshot ? await w.__xgisSnapshot() : null
  })) as Snapshot | null
  if (!snap) throw new Error('window.__xgisSnapshot is unavailable on this page')
  const worldTiles = snap.sources.world?.tiles ?? []
  const both = findBothAntimeridianSides(worldTiles)
  expect(
    both.found,
    `Sphere-routed tile selection must keep tiles on BOTH sides of the ` +
      `antimeridian (x=0 AND x=2^z−1 at the same z) once the camera faces ` +
      `lon=180. ${both.detail}. routeToSphereSelector is probably severed ` +
      `or not reached (geo/src/projections-table.ts:223).`,
  ).toBe(true)

  // ─── EFFECT — the pre-existing pixel guard (unchanged threshold) ────────
  // Pre-wire-in baseline was effectively 0 (Pacific hemisphere
  // entirely empty, only Pacific-island stroke pixels of a few dots).
  expect(
    dark,
    `Pacific hemisphere appears empty (${dark} dark-fill px). ` +
      `globeVisibleTiles is probably not wired into vector-tile-renderer.ts.`,
  ).toBeGreaterThan(DARK_FILL_MIN)
})
