import { test, expect } from '@playwright/test'

// The MapLibre demo style's LABELS render — the coverage this leg did not have.
//
// Five PRs in a row changed line-label placement (#1421 world-anchored phase,
// #1423 the curved branch, #1425 the collision footprint, #1431 the
// `text-max-angle` spec default, #1441 the emitter extraction) and every one was
// measured against OFM Positron alone. The only demo-style coverage on this leg is
// `_fills-gl2-gate`, which asserts POLYGONS. Nothing asserted that the demo style
// still draws a label at all.
//
// WHAT THIS DOES AND DOES NOT COVER, established by mutation rather than by
// reading. `geolines-label` is `symbol-placement: line`, so it was expected to
// exercise #1431's `text-max-angle` default — it does NOT. Dropping that default
// from 45° to 0.5° leaves this gate green, because these labels resolve to the
// VIEWPORT-ALIGNED branch (the style's own conversion note says so: pitch-alignment
// resolves to "map" but the runtime renders them viewport-aligned), and the angular
// gate lives only in the curved branch. So this covers the line-label WALK — the
// world lattice, the spacing cadence, the edge-inset cull, the emitter — and not
// the curved shaping path. A gate for that still needs a style whose line labels
// actually curve.
//
// Assertions are on the label PIPELINE, not on pixels. `getDispatchedLabelTexts`
// says which strings reached TextStage and `getLastLabelCounts` says how many
// survived collision to reach `setDraws` — so a failure names its own stage
// (never dispatched vs dispatched-then-dropped) instead of reporting "the screen
// looks wrong". A pixel count could not tell those apart, and CLAUDE.md §12
// records what a pixel-count gate is worth: it passes on broken images.
//
// Runs on WebGl2Device under headless SwiftShader, like its `_fills-gl2-gate`
// sibling. Needs egress for the style + its TileJSON, same as the other live
// specs on this leg.

/** The four geolines the demo style labels, each `symbol-placement: line` — the
 *  placement class the line-label work moved. (Not all four are in view at the
 *  pinned camera; the assertion below requires at least one, not all.) */
const GEOLINES = ['Equator', 'Tropic of Cancer', 'Tropic of Capricorn', 'Arctic Circle']

// The camera is pinned, and z2 is not arbitrary: the demo's OWN default camera is
// z7.18, where this style labels nothing at all (measured: 0 submitted) because
// the geolines source and the country-label size stops both live at z2-6. A gate
// left on the default camera would have asserted the absence of labels and passed
// forever without touching the pipeline it exists to watch.
const CAMERA = '2/20/0'

test('the MapLibre demo style draws its labels on WebGl2Device (?forcegl2=1)', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.goto(`/demo.html?id=import_maplibre_demo&forcegl2=1&e2e=1#${CAMERA}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 60_000 },
  )

  // `__xgisReady` fires before tiles land, and label dispatch needs decoded
  // tiles AND a loaded glyph atlas. Poll rather than sleep: SwiftShader's pace
  // varies with the parallel load on this leg, and a fixed wait here is how a
  // gate becomes a flake.
  const read = () =>
    page.evaluate(() => {
      const w = window as unknown as {
        __xgisActiveBackend?: string
        __xgisMap?: {
          getDispatchedLabelTexts?: () => string[] | null
          getLastLabelCounts?: () => { submitted: number; drawn: number } | null
        }
      }
      const m = w.__xgisMap
      return {
        backend: w.__xgisActiveBackend ?? null,
        texts: m?.getDispatchedLabelTexts?.() ?? null,
        counts: m?.getLastLabelCounts?.() ?? null,
      }
    })

  // Poll until the LINE-placed labels specifically have landed, not merely until
  // something drew: the point-placed country names arrive first and would end the
  // wait before the geolines were dispatched, turning assertion 3 into a race.
  let seen = await read()
  for (let i = 0; i < 60; i++) {
    const drawn = seen.counts?.drawn ?? 0
    if (drawn > 0 && GEOLINES.some((g) => (seen.texts ?? []).some((t) => t.includes(g)))) break
    await page.waitForTimeout(1000)
    seen = await read()
  }

  // Non-vacuity first: a silent fall back to another backend would let this pass
  // without ever exercising the WebGL2 path this leg exists to gate.
  expect(seen.backend, 'must be running on WebGl2Device').toBe('webgl2')
  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])

  const texts = seen.texts ?? []
  const counts = seen.counts

  // 1. Labels reached the stage at all.
  expect(texts.length, 'no label text reached TextStage').toBeGreaterThan(0)

  // 2. Labels survived collision and reached the renderer. This is a WHOLE-FRAME
  //    count, and the point-placed country names keep it positive on their own —
  //    so it catches a total collapse of the draw path, not a line-label-specific
  //    drop. Assertion 3 is the one that discriminates; this one is here because
  //    "dispatched but nothing drawn" is a distinct failure worth naming, and the
  //    counters can tell it apart from "never dispatched" where pixels cannot.
  expect(counts, 'no label counters — TextStage was never built').not.toBeNull()
  expect(
    counts!.drawn,
    `labels were dispatched (${counts!.submitted}) but none reached the renderer`,
  ).toBeGreaterThan(0)

  // 3. The LINE-placed labels specifically — the class the line-label work moved,
  //    and the discriminating assertion. Verified by mutation: making the world
  //    lattice never land a stop fails HERE with the country names still listed in
  //    the message, which is exactly the failure the point labels would otherwise
  //    mask.
  const drawnGeolines = GEOLINES.filter((g) => texts.some((t) => t.includes(g)))
  expect(
    drawnGeolines,
    `no symbol-placement:line label dispatched. Got: ${texts.slice(0, 40).join(', ')}`,
  ).not.toHaveLength(0)
})
