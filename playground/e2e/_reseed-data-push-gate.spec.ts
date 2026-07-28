import { test, expect, type Page } from '@playwright/test'

// RESEED DATA-PUSH GATE (#1402) — a host `setSourceData()` push into a virtual-tiled
// GeoJSON source must actually reach the screen.
//
// The regression this gates: #1371 made a re-seed ATOMIC by swapping the source's BACKEND on
// the live catalog and asking the renderer to re-upload the affected tiles. The CPU half
// worked — the catalog held the new tiles — but the GPU half was a no-op, because the upload
// path short-circuits on `layerCache.has(key)` ("already uploaded") and a replacement is by
// definition an upload onto a key that IS resident. The replacement was dropped on the floor
// and the key had already been drained from the replaced-set, so nothing ever retried: the
// layer drew the PREVIOUS data for the lifetime of the source.
//
// It survived review because the verification demo pushed a MOVING POINT: the new data left
// each tile empty, which routes through `applyReplacedTiles`' drop branch instead of the
// upload, so the one case that was checked is the one case that worked. Any push where the
// tile still has data — i.e. every basemap-shaped push — hit the no-op.
//
// Why an e2e and not a unit test: the defect lives in the seam between the catalog (CPU cache,
// data/) and the upload coordinator (GPU residency, map/). Both halves' own tests passed. Only
// a real device shows that the pixels never changed. The catalog-side half — a refresh being
// silently truncated by the concurrency cap — is pinned deterministically in
// `data/src/tile-catalog-reseed.test.ts`; this gate covers the GPU swap.
//
// Offline by construction: the fixture is synthesised in-page, so this runs headless under
// SwiftShader with no network egress.
//
//   HEADED=0 XGIS_SOFTWARE_GPU=1 playwright test _reseed-data-push-gate.spec.ts

const CAM = '#10.35/30.94337/118.42256/356.5/60'
const SOURCE = 'land'

/** Total triangles the named source contributed to the last frame. */
async function sourceTris(page: Page, name: string): Promise<number> {
  return await page.evaluate((n) => {
    const pipe = (
      window as unknown as { __xgisMap?: { inspectPipeline(): unknown } }
    ).__xgisMap?.inspectPipeline() as
      { sources?: Array<{ name: string; frame: { triangles: number } }> } | undefined
    return (pipe?.sources ?? []).find((s) => s.name === n)?.frame.triangles ?? -1
  }, name)
}

/** Wait until the source's contribution stops moving, then return it.
 *
 *  A POLL, not a fixed sleep. The fixed 8-10 s waits this replaced were a guess that was both
 *  too slow for the render-gate's budget (this became its most expensive spec, and on a loaded
 *  runner the timeout fired during fixture setup) and not actually a convergence proof. The
 *  measured settle is ~2.5 s; `stableFor` samples is the evidence, and the cap keeps a genuine
 *  hang a failure rather than a wedge.
 *
 *  Pre-fix this still returns promptly — the stale frame settles at the WRONG value and stays
 *  there, which is exactly what the assertion catches. */
async function settle(page: Page, stableFor = 6, capMs = 45_000): Promise<number> {
  const t0 = Date.now()
  let last = -1
  let stable = 0
  while (Date.now() - t0 < capMs) {
    await page.waitForTimeout(500)
    const n = await sourceTris(page, SOURCE)
    if (n === last) stable++
    else stable = 0
    last = n
    if (stable >= stableFor) break
  }
  return last
}

/** Push a deterministic grid of many-vertex polygons centred on the camera. `grid²` features,
 *  so the caller can make two pushes that are unmistakably different sizes. */
async function push(page: Page, grid: number): Promise<number> {
  return await page.evaluate(
    ({ grid, sourceId }) => {
      const ring = 24,
        lon = 118.42256,
        lat = 30.94337
      const span = 0.9,
        step = span / grid,
        r = step * 0.34
      const features: unknown[] = []
      for (let iy = 0; iy < grid; iy++)
        for (let ix = 0; ix < grid; ix++) {
          const cx = lon - span / 2 + (ix + 0.5) * step
          const cy = lat - span / 2 + (iy + 0.5) * step
          const coords: [number, number][] = []
          for (let k = 0; k <= ring; k++) {
            const a = (k / ring) * Math.PI * 2
            const rr = r * (1 + 0.25 * Math.sin(a * 7))
            coords.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a) * 0.85])
          }
          features.push({
            type: 'Feature',
            properties: { id: iy * grid + ix },
            geometry: { type: 'Polygon', coordinates: [coords] },
          })
        }
      ;(
        window as unknown as { __xgisMap?: { setSourceData(id: string, d: unknown): void } }
      ).__xgisMap?.setSourceData(sourceId, { type: 'FeatureCollection', features })
      return features.length
    },
    { grid, sourceId: SOURCE },
  )
}

// Serial, and the timeout is set HERE rather than inside a test body: a body-scope
// `test.setTimeout` does not cover fixture setup, and on a loaded runner this leg's context
// setup is exactly where the budget ran out (#1448 CI run 30344914959).
test.describe.configure({ mode: 'serial', timeout: 180_000 })

test('a host data push reaches the GPU, and a second push replaces the first (#1402)', async ({
  page,
}) => {
  const errors: string[] = []
  // The fixture is synthesised in-page, but the DEMO still reaches for its own basemap assets,
  // and whether those resolve depends on the runner's egress — not on anything this gate is
  // about. Resource-fetch failures are excluded by name so the gate stays meaningful offline;
  // every other console error and every uncaught exception still fails it.
  const isNetworkNoise = (m: string): boolean => /Failed to load resource/i.test(m)
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && !isNetworkNoise(m.text())) errors.push(m.text())
  })

  await page.setViewportSize({ width: 430, height: 715 })
  await page.goto(`/demo.html?id=physical_map&forcegl2=1&e2e=1&adaptive=0${CAM}`, {
    waitUntil: 'load',
  })
  await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady, {
    timeout: 60_000,
  })
  // Let the demo's own tiles finish loading, so the push lands on a settled source rather than
  // racing the initial load (both paths must work; a settled source is the reproducible one).
  await page.waitForTimeout(12_000)

  const before = await sourceTris(page, SOURCE)
  // Liveness, not just a number: a dead source reports 0 and would make any "it grew" assertion
  // vacuous. The stock physical_map land layer is sparse but non-empty at this camera.
  expect(before, `source "${SOURCE}" must exist and be drawing before the push`).toBeGreaterThan(0)

  const pushedA = await push(page, 90)
  expect(pushedA).toBe(8100)
  await page.waitForTimeout(8000)
  const afterA = await sourceTris(page, SOURCE)

  // The bug's signature is `afterA === before` — byte-identical, forever. A dense grid of 8100
  // 25-vertex polygons over the viewport is orders of magnitude more geometry than the stock
  // coastline, so a generous floor still fails hard on the no-op. Deliberately NOT a tight
  // band: the exact count depends on per-zoom simplification, which is free to change.
  expect(afterA, 'the pushed geometry must reach the frame').toBeGreaterThan(before * 20)
  expect(afterA).toBeGreaterThan(10_000)

  // A SECOND push must land too. This is what separates "the swap works" from "the source got
  // torn down and rebuilt once": the re-seed path keeps the catalog alive, so every later push
  // takes the same replacement route, and a route that only works once is still broken.
  //
  // The assertion is that the frame CHANGED materially, not that it shrank. The fixture covers a
  // fixed 0.9° span, so a coarser grid means fewer but proportionally LARGER polygons, and how
  // much geometry survives per-zoom simplification is not a function of feature count — an
  // earlier draft asserted a direction and failed on exactly that. "Changed" is also the sharper
  // gate: the defect's signature is a byte-identical frame, forever.
  const pushedB = await push(page, 30)
  expect(pushedB).toBe(900)
  await page.waitForTimeout(8000)
  const afterB = await sourceTris(page, SOURCE)
  const delta = Math.abs(afterB - afterA) / afterA
  expect(delta, `a second push must replace the first (${afterA} → ${afterB})`).toBeGreaterThan(0.2)
  expect(afterB, 'and must not blank the layer').toBeGreaterThan(0)

  expect(errors, 'no page/console errors during the pushes').toEqual([])
})

test('ONE push converges on its own — no second push, no interaction (#1448)', async ({ page }) => {
  // THE DEFECT THIS GATES. `applyReplacedTiles` swaps a re-seed replacement in at the START of
  // a frame, and the idle-skip gate asked only "is a tile still FETCHING?". A replacement that
  // arrived after the last frame therefore needed a frame nobody would ask for: the loop
  // stopped with the swap still owed and the layer drew the PREVIOUS seed's tiles for the rest
  // of the source's life.
  //
  // Measured before the fix, on this fixture: one push settled at 2.3-3.5x the geometry the
  // data contains and held it FLAT for 60 s (24 samples, `pendingLoads`/`pendingUploads` 0
  // throughout). A single explicit `invalidate()` corrected it, which is what identified the
  // missing keep-alive. The residue was nondeterministic (27 994 / 28 023 / 28 096 / 30 246 /
  // 43 840 across runs) because it is however many tiles happened to land after the last frame
  // — and that nondeterminism is what made #1420's `delta > 0.2` bound flake.
  //
  // The assertion is CONVERGENCE, not a magnitude: push the same data twice with a settle
  // between, and the two readings must AGREE. A second push is the thing that used to hide the
  // bug, so using it as the reference is what makes this gate sharp — if the first push
  // converged, the second changes nothing.
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.setViewportSize({ width: 430, height: 715 })
  await page.goto(`/demo.html?id=physical_map&forcegl2=1&e2e=1&adaptive=0${CAM}`, {
    waitUntil: 'load',
  })
  await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady, {
    timeout: 60_000,
  })
  await settle(page)

  // Seed with the dense grid so the sparse push below has something to replace.
  await push(page, 90)
  await settle(page)

  await push(page, 30)
  const once = await settle(page)
  expect(once, 'the layer must not be blank').toBeGreaterThan(0)

  // The reference: the state a SECOND identical push reaches. Pre-fix this was where the
  // stragglers finally got swapped, and `once` sat 2.3x above it.
  await push(page, 30)
  const twice = await settle(page)

  expect(
    Math.abs(once - twice) / twice,
    `one push must already be converged (one=${once}, two=${twice})`,
  ).toBeLessThan(0.02)

  expect(errors, 'no page errors').toEqual([])
})
