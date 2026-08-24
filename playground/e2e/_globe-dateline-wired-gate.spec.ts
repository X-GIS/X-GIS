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
  /** Tiles at z>=1 — the ONLY ones this function looks at. Returned so the caller's
   *  "nothing was selected" branch keys on the same quantity that makes `detail` say
   *  `(none)`, instead of on `tiles.length` and drifting from it. */
  considered: number
} {
  const byZ = new Map<number, Set<number>>()
  let considered = 0
  for (const t of tiles) {
    if (t.z < 1) continue
    considered++
    if (!byZ.has(t.z)) byZ.set(t.z, new Set())
    byZ.get(t.z)!.add(t.x)
  }
  for (const [z, xs] of byZ) {
    const tileN = Math.pow(2, z)
    if (xs.has(0) && xs.has(tileN - 1)) {
      return {
        found: true,
        detail: `z=${z} has tiles at x=0 AND x=${tileN - 1} (tileN=${tileN})`,
        considered,
      }
    }
  }
  const dump = [...byZ.entries()]
    .map(([z, xs]) => `z${z}:[${[...xs].sort((a, b) => a - b).join(',')}]`)
    .join(' ')
  return {
    found: false,
    detail: `no z level had tiles on both x=0 and x=(tileN-1); selected: ${dump || '(none)'}`,
    considered,
  }
}

test('globe @ dateline renders the Pacific hemisphere', async ({ page }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1024, height: 720 })
  // Collected for the "nothing was selected" branch below: when the page never gets as
  // far as requesting a tile, the reason is usually here and nowhere else.
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)))
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

  // ── Converge on the CAUSE, then measure the EFFECT (#1895) ──
  //
  // `__xgisReady` fires when the map is live, NOT when it has painted: measured
  // on the software rasterizer (XGIS_SOFTWARE_GPU=1) this page reports ready at
  // ~3 s and the canvas is still ENTIRELY unpainted at +6 s, reaching its steady
  // 6.6k dark-fill px only around +32 s, because the `dark` demo compiles a
  // 14.6 MB countries.geojson before the first tile can draw. A fixed
  // `waitForTimeout(2500)` reads the frame before anything exists — reproduced
  // here, it fails 1 run in 3 with the CAUSE assertion's own
  // `selected: (none)`, which is exactly how this gate went red on PR #1894
  // while passing on the PR one commit below it.
  //
  // Polling the DARK-FILL PROXY (the shape this had before) narrows that window
  // without closing it, for two measured reasons:
  //
  //  1. it does not imply the thing the CAUSE assertion reads. Dark pixels can
  //     come from the globe body; tiles are what `sources.world.tiles` counts.
  //  2. `sampleDarkFill` is a screenshot + in-page PNG decode + region scan, and
  //     it queues behind the very GeoJSON compile it is waiting on — one
  //     iteration measured 26 s of a 120 s budget (samples at +2.0, +3.4, +4.7,
  //     +5.9, then +32.5 s). Four samples in, the budget is a third gone. On a
  //     slower runner the loop can spend the whole budget and still conclude
  //     "empty" from a frame that had not rendered.
  //
  // So converge on the QUANTITY THE ASSERTION READS — a non-empty, stable world
  // tile set — polled through the cheap snapshot instead of a screenshot.
  //
  // `getMissingTileCount()` is NOT usable here, and the measurement is the whole
  // reason to say so: on this page it reads 0 from the first sample onward,
  // 30 seconds before a single tile exists. It counts tiles IN FLIGHT, so during
  // the GeoJSON compile — nothing requested yet — "finished" and "not started"
  // are the same number. It is the right signal for `_1581-static-camera-render-
  // gate` and `_scene-builder-twin` (tile-driven pages) and carries no
  // information on this one. Do not "restore" it here.
  //
  // This does NOT weaken the gate. The wait requires only that SOME stable
  // non-empty set was selected; the assertion below still decides whether that
  // set spans both sides of the antimeridian, so a severed selector that
  // stably picks one side fails exactly as before — and one that picks nothing
  // burns the budget and still fails with `selected: (none)`.
  const readSnapshot = async (): Promise<Snapshot | null> =>
    (await page.evaluate(async () => {
      const w = window as unknown as { __xgisSnapshot?: () => Promise<unknown> }
      return w.__xgisSnapshot ? await w.__xgisSnapshot() : null
    })) as Snapshot | null

  const tileKey = (s: Snapshot | null): string =>
    (s?.sources.world?.tiles ?? [])
      .map((t) => `${t.z}/${t.x}/${t.y}`)
      .sort()
      .join(',')

  const SELECT_BUDGET_MS = 120_000
  const selectStart = Date.now()
  const deadline = selectStart + SELECT_BUDGET_MS
  let snap = await readSnapshot()
  let prevKey = tileKey(snap)
  let stable = 0
  // Recorded, not inferred: the loop exits two ways and the caller must tell them
  // apart. Falling through on the deadline and asserting on the last read is how a
  // never-loaded page came to be reported as a broken selector.
  let converged = false
  while (Date.now() < deadline) {
    await page.waitForTimeout(500)
    snap = await readSnapshot()
    const key = tileKey(snap)
    if (key !== '' && key === prevKey) {
      if (++stable >= 2) {
        converged = true
        break // three identical non-empty reads in a row
      }
    } else {
      stable = 0
    }
    prevKey = key
  }
  const selectMs = Date.now() - selectStart

  // The EFFECT sample now costs one screenshot, not one per second.
  let dark = await sampleDarkFill()
  for (let i = 0; i < 20 && dark <= DARK_FILL_MIN && Date.now() < deadline; i++) {
    await page.waitForTimeout(1000)
    dark = await sampleDarkFill()
  }

  // ─── CAUSE — the selected tile set, asserted BEFORE the pixel effect ────
  // (#1774 / §12: order decides which assertion names the real break.)
  if (!snap) throw new Error('window.__xgisSnapshot is unavailable on this page')
  const worldTiles = snap.sources.world?.tiles ?? []
  const both = findBothAntimeridianSides(worldTiles)

  // ─── Which failure IS this? Split the two states the fall-through conflates ──
  //
  // The convergence loop falls through when its budget expires and then asserts on
  // whatever it last read. That makes ONE message carry TWO different failures: a
  // selector that stably picked one side, and a page that never selected anything.
  //
  // On CI it has been the second. Run 32366886231 failed all three attempts with
  // `selected: (none)` — zero tiles at any z — while the message blamed
  // `routeToSphereSelector`, which is never even reached with an empty set. Timing
  // corroborated it: failing attempts took ~2.1 min ≈ the whole budget, passing ones
  // 34-55 s, and locally the set converges in 18-25 s with ~5x margin. So the next
  // person was sent to a file that was working (#1924).
  //
  // Asserting the DISTINGUISHABLE state first is the fix — §12's "order decides which
  // half a red run accuses", which this spec already applies between cause and effect
  // and simply did not apply between these two causes.
  //
  // NOT raising the budget: nothing shows 120 s is nearly enough on CI, and a bigger
  // number would only move the same misattribution later.
  if (both.considered === 0) {
    throw new Error(
      `No tile was ever selected — the page did not get as far as requesting one.
` +
        `  converged=${converged}, ${selectMs}ms of the ${SELECT_BUDGET_MS}ms budget, ` +
        `${worldTiles.length} raw tile(s), ${pageErrors.length} page error(s).
` +
        (pageErrors.length
          ? `  page errors: ${pageErrors.join(' | ')}
`
          : '') +
        `  This is NOT a routeToSphereSelector verdict. That selector decides WHICH ` +
        `tiles are kept and cannot produce an empty set; with nothing selected it was ` +
        `never consulted. Look at boot/data — a stalled fetch, a page error above — or ` +
        `at the runner being too slow for the budget. Do not "fix" the selector.`,
    )
  }

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
