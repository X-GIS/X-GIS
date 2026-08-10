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
// The camera is z1.5 for a reason that makes every assertion below
// line-label-specific. `geolines-label` has minzoom 1 and `countries-label`
// minzoom 2, so in the window between them this style draws ONLY line-placed
// labels — which turns the whole-frame `drawn` counter into a line-label counter.
// At z2 the point-placed country names flood in and keep `drawn` positive on their
// own, which is exactly how a gate stops discriminating.
//
// (An earlier revision of this file claimed these labels resolve to the
// VIEWPORT-ALIGNED branch, "established by mutation". That was wrong twice over.
// They take the CURVED branch — `text-rotation-alignment` is unauthored, so it
// resolves to `auto`, which is `map` for line placement. And the mutation that
// "established" it was invalid: it asserted on getDispatchedLabelTexts, which
// records at SUBMIT time, while the angular gate runs later in prepare(). Dispatch
// was never going to move. Asserting `drawn` at a geolines-only camera is what
// actually reaches that stage.)
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

// The demo's OWN default camera is z7.18, where this style labels nothing at all
// (measured: 0 submitted). A gate left on the default would have asserted the
// absence of labels and passed forever without touching the pipeline it watches.
const CAMERA = '1.5/20/140'

// BOTH projections, because they cover different halves of the path and neither
// alone is enough. Established by running the same three mutations against each:
//
//                                     mercator   globe
//   text-max-angle 45° → 0.5°           pass      FAIL   ← curved shaping
//   world lattice lands no stop         FAIL      pass   ← the spacing walk
//   #1314 edge inset rejects all        FAIL      FAIL
//
// In mercator these geolines are straight horizontal rules, so per-glyph
// deflection is ~0 and no angular gate can bite. On the globe the same parallels
// arc, the labels ride that arc — and the runs are short enough there that the
// walk takes its single-midpoint branch instead of the spacing lattice. Drop
// either camera and one of the two mutations above stops being caught.
const PROJECTIONS = ['mercator', 'globe'] as const

for (const proj of PROJECTIONS) {
  test(`the MapLibre demo style draws its labels on WebGl2Device — ${proj} (?forcegl2=1)`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
        errors.push(m.text().slice(0, 300))
    })

    await page.goto(`/demo.html?id=import_maplibre_demo&forcegl2=1&e2e=1&proj=${proj}#${CAMERA}`, {
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

    // 2. Labels survived every later stage and reached the renderer. At this camera
    //    the ONLY labels in the style are line-placed, so this whole-frame count is
    //    line-label-specific — and it is the assertion that reaches past dispatch
    //    into shaping and collision. Dropping #1431's text-max-angle default to 0.5°
    //    leaves `submitted` at 4 and takes `drawn` to 0; this is what sees that.
    expect(counts, 'no label counters — TextStage was never built').not.toBeNull()
    expect(
      counts!.drawn,
      `labels were dispatched (${counts!.submitted}) but none reached the renderer`,
    ).toBeGreaterThan(0)

    // 3. The line labels reached the stage BY NAME, so a frame that drew some other
    //    label would not stand in for them. Verified by mutation: making the world
    //    lattice never land a stop fails here.
    const drawnGeolines = GEOLINES.filter((g) => texts.some((t) => t.includes(g)))
    expect(
      drawnGeolines,
      `no symbol-placement:line label dispatched. Got: ${texts.slice(0, 40).join(', ')}`,
    ).not.toHaveLength(0)
  })
}
