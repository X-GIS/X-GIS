// Verify the projection-aware world-copy gate (worldCopiesFor()):
// Mercator enumerates ±N world copies at low zoom, non-Mercator projections
// render a single world.
//
// ── What this asserts, and why it is not `drawCalls` ──
//
// The original mercator arm asserted `drawCalls > 20` on the physical_map_50m
// demo. That number is 4 sources x 6 tiles: it measures the demo's SOURCE COUNT,
// not world copies. Deleting a layer from the demo would have turned it red, and
// — the failure that matters — a regression that switched Mercator to
// single-world would have left it GREEN at 4 sources x 4 tiles = 16... only just
// under, and green outright on any 6-source demo. An assertion has to distinguish
// the states of the thing it tests (CLAUDE.md §12); that one distinguished the
// wrong axis.
//
// The world-copy signal is PER-SOURCE tilesVisible, against a ceiling DERIVED
// from the tile zoom the frame reports (`singleWorldMaxTiles`) rather than a
// literal. One world at tile zoom z holds 4^z tiles, so exceeding that proves a
// copy was enumerated — at any camera. Measured here: tile zoom 1, ceiling 4,
// observed 6 (three columns; the third is the copy). Independent of how many
// layers the demo declares, and independent of where the camera sits.
//
// ── Why physical_map and not physical_map_50m ──
//
// The 50m demo needs `ne_50m_*` assets, which are gitignored bulk data (see
// playground/public/AGENTS.md — `bun run fetch:demo-data`). CI checks out fresh
// and does not fetch them, so that arm could never run there: the dev server
// answers the missing file with an HTML 404 at status 200 and the demo hangs
// before __xgisReady. physical_map uses the checked-in 110m layers and produces
// the identical per-source tile counts (measured: 6 either way; only the source
// count differs, 3 vs 4 — which is precisely the axis this no longer asserts on).
//
// ── Why the settle is a loop and not a sleep ──
//
// The original waited a flat 2500 ms after __xgisReady. That is a RACE, and it is
// why this gate sat dark: measured over three cold loads at the same camera, two
// read 24 and one read 4 (`ocean:0 rivers:0` — the tiles simply had not landed).
// Polling the tile-load diagnostic to quiescence makes it deterministic: 18/18
// and 24/24 across repeated runs. Same class as #1733's fix for
// _gl2-live-swap-gate — a wall-clock pump replaced by an actual settle.

import { test, expect, type Page } from '@playwright/test'

type Win = Window & {
  __xgisReady?: boolean
  __xgisMap?: {
    invalidate?: () => void
    getTileLoadDiagnostic?: () => Record<string, { catalogLoading: number; uploadQueued: number }>
  }
}

interface SourceStat {
  name: string
  cache?: number
  tilesVisible?: number
  drawnByZoom?: ReadonlyArray<readonly [number, number]>
}

async function loadAndDump(
  page: Page,
  demo: string,
  hash: string,
): Promise<{ drawCalls?: number; vertices?: number; sources?: SourceStat[] }> {
  await page.goto(`/demo.html?id=${demo}${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 30_000,
  })
  // #2478 — settle on the PRECONDITION this gate asserts, and say which arm ended the
  // wait.
  //
  // This used to poll `catalogLoading + uploadQueued === 0` and then swallow its own
  // timeout with `.catch(() => {})`, which made a 30 s give-up and a real convergence
  // indistinguishable to everything downstream. That is why the `got [0, 1]` throw from
  // `singleWorldMaxTiles` below arrives with no way to tell whether the frame was
  // unsettled or the settle simply gave up (render-shard 6/6, run 33726397689 — three
  // attempts, same throw). An unattributable red is the expensive part, so the wait now
  // reports.
  //
  // The old predicate was also a proxy rather than the asserted quantity: `uploadQueued`
  // is `UploadCoordinator.queueSize()` (upload-coordinator.ts:418-420), QUEUED ONLY,
  // excluding in-flight and cap-deferred uploads that `pendingCount()` (:414-416) counts.
  // What this gate needs is narrower than either — ONE tile zoom per drawing source,
  // exactly what `singleWorldMaxTiles` demands — so wait on that directly.
  //
  // MEASURED on this fixture and camera (physical_map #1.5/0/100/0/0, 1280x720, headless
  // SwiftShader, 2 Hz): the single-zoom state holds from 1.1 s, the same sample the old
  // proxy cleared on, and stays for 120 consecutive samples. So this costs nothing here.
  // It is NOT claimed to fix the CI red: that does not reproduce off-CI, so no local run
  // can establish it. It makes the next occurrence name its own cause.
  const settled = await page
    .waitForFunction(
      () => {
        // `any`: inspectPipeline()'s DECLARED frame type is { tilesVisible, missedTiles }
        // and carries no `drawnByZoom`, though the runtime object does — the same reason
        // the evaluate at the bottom of this function reaches the map through `any`.

        const m = (window as unknown as { __xgisMap?: any }).__xgisMap
        if (!m?.inspectPipeline) return true
        m.invalidate?.()
        // NOTE the `.frame` nesting: `SourceStat` above is this file's FLATTENED dto, built
        // by the evaluate below. The raw inspectPipeline() source keeps these under `frame`.
        type RawSource = {
          frame?: { tilesVisible?: number; drawnByZoom?: ReadonlyArray<readonly [number, number]> }
        }
        const drawing = ((m.inspectPipeline()?.sources ?? []) as RawSource[]).filter(
          (s) => (s.frame?.tilesVisible ?? 0) > 0,
        )
        if (drawing.length === 0) return false
        return drawing.every(
          (s) => (s.frame?.drawnByZoom ?? []).filter(([, n]) => n > 0).length === 1,
        )
      },
      null,
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false)
  if (!settled) {
    console.log(
      `[world-copies] settle TIMED OUT after 30s on ${demo} — the drawn set never reduced to ` +
        `one tile zoom per source. Any assertion below is measuring an unsettled frame.`,
    )
  }
  // The 1500 ms tail stays. It looks like dead weight and may not be: removing an
  // apparently-unread `page.screenshot` from `_filter-gdp-z-fighting` cut that oracle's
  // sample from 86 rows to 24 because the call was load-bearing settle (#2460). Same trap
  // shape, so it goes only with a before/after measurement of its own.
  await page.waitForTimeout(1500)
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
  return await page.evaluate(() => {
    const map = (window as unknown as { __xgisMap?: any }).__xgisMap
    const pipe = map?.inspectPipeline?.()
    const stats = map?._stats ?? {}
    return {
      drawCalls: stats.drawCalls,
      vertices: stats.vertices,
      sources: pipe?.sources?.map((s: any) => ({
        name: s.name,
        cache: s.cache?.size,
        tilesVisible: s.frame?.tilesVisible,
        drawnByZoom: s.frame?.drawnByZoom,
      })),
    }
  })
}

/** The single-world ceiling, DERIVED from the tile zoom the frame actually drew rather than
 *  hard-coded.
 *
 *  One world at tile zoom z holds 2^z x 2^z tiles, so a single-world render can never draw
 *  more than 4^z of them — at any camera, any viewport. Exceeding it therefore PROVES a ±N
 *  copy was enumerated, which is the property this gate exists to assert.
 *
 *  Hard-coding 4 was correct at this camera and only at this camera: it was measured by
 *  severing `copyOrder` (data/src/tiles-sse.ts) and observing exactly 4. But nothing pinned
 *  the camera, so moving it could have raised the true single-world count above 4 and left
 *  this gate passing with copies DISABLED — silently vacuous, the exact failure class the
 *  gate was rewritten to escape. Deriving the bound removes that coupling: the assertion can
 *  now only fail loudly on drift, never pass quietly. */
function singleWorldMaxTiles(drawnByZoom: ReadonlyArray<readonly [number, number]>): number {
  const zooms = drawnByZoom.filter(([, n]) => n > 0).map(([z]) => z)
  if (zooms.length !== 1) {
    throw new Error(
      `expected one tile zoom in the drawn set, got [${zooms.join(', ')}] — the single-world ` +
        `ceiling is per-zoom, so a mixed set makes the bound ambiguous. Re-derive it before ` +
        `trusting this gate at this camera.`,
    )
  }
  return 4 ** zooms[0]!
}

test('mercator demo: world copies enumerated (per-source tiles exceed one world)', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  // Pan well off-centre, at a zoom inside WORLD_COPY_MAX_ZOOM (4), where the
  // copy enumeration is live.
  const stats = await loadAndDump(page, 'physical_map', '#1.5/0/100/0/0')
  console.log(`[mercator] drawCalls=${stats.drawCalls} sources=${JSON.stringify(stats.sources)}`)

  const drawing = (stats.sources ?? []).filter((s) => (s.tilesVisible ?? 0) > 0)
  // Floor first: without it, "every source drew more than one world" is vacuously
  // true when nothing drew at all (the exact state the old flat-sleep produced).
  expect(drawing.length, 'every declared source drew something').toBe(3)
  for (const s of drawing) {
    const ceiling = singleWorldMaxTiles(s.drawnByZoom ?? [])
    expect(
      s.tilesVisible,
      `${s.name}: ${s.tilesVisible} visible tiles is within a single world ` +
        `(<= ${ceiling} at tile zoom ${(s.drawnByZoom ?? []).map(([z]) => z).join('/')}) — ` +
        `Mercator should have enumerated ±N copies`,
    ).toBeGreaterThan(ceiling)
  }
})

test('orthographic demo: single world (no ±N copy enumeration)', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const stats = await loadAndDump(page, 'fixture_projection_orthographic', '')
  console.log(`[ortho] drawCalls=${stats.drawCalls} sources=${JSON.stringify(stats.sources)}`)
  // Orthographic should render normally (no tile-selection regression)
  expect(stats.drawCalls, 'ortho demo should still draw tiles').toBeGreaterThan(0)
  // tilesVisible should be modest (single world, no wrap multiplier)
  for (const s of stats.sources ?? []) {
    if (s.tilesVisible != null && s.tilesVisible > 0) {
      expect(s.tilesVisible, `${s.name} tilesVisible bounded for non-Mercator`).toBeLessThan(200)
    }
  }
})

test('natural_earth demo: single world', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const stats = await loadAndDump(page, 'fixture_projection_natural_earth', '')
  console.log(
    `[natural_earth] drawCalls=${stats.drawCalls} sources=${JSON.stringify(stats.sources)}`,
  )
  expect(stats.drawCalls, 'natural_earth demo should still draw tiles').toBeGreaterThan(0)
})
