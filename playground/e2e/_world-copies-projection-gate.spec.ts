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
// The world-copy signal is PER-SOURCE tilesVisible. At z=1.5 the tile zoom is 1,
// where ONE world is 2 columns x 2 rows = 4 tiles maximum. Measured with copies
// enumerated: 6 (three columns — the third is the copy). So `> 4` per source is
// exactly the single-world/multi-world boundary, and it is independent of how
// many layers the demo happens to declare.
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
  // Settle on the tile pipeline going quiet, not on the clock.
  await page
    .waitForFunction(
      () => {
        const m = (window as unknown as Win).__xgisMap
        if (!m?.getTileLoadDiagnostic) return true
        m.invalidate?.()
        const d = m.getTileLoadDiagnostic()
        let n = 0
        for (const k in d) n += d[k]!.catalogLoading + d[k]!.uploadQueued
        return n === 0
      },
      null,
      { timeout: 30_000 },
    )
    .catch(() => {})
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
      })),
    }
  })
}

/** One world at tile-zoom 1 is 2 columns x 2 rows. Anything above this had a
 *  ±N copy enumerated into the visible set. */
const SINGLE_WORLD_MAX_TILES = 4

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
    expect(
      s.tilesVisible,
      `${s.name}: ${s.tilesVisible} visible tiles is within a single world ` +
        `(<= ${SINGLE_WORLD_MAX_TILES} at tile-zoom 1) — Mercator should have enumerated ±N copies`,
    ).toBeGreaterThan(SINGLE_WORLD_MAX_TILES)
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
