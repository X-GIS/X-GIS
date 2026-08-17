import { test, expect, type Page } from '@playwright/test'

// ADAPTIVE QUALITY LADDER GATE (#1393) — the controller must actually buy frame time
// on a host that cannot keep up, and it must buy it from the HORIZON first.
//
// What this asserts is the OBSERVABLE consequence, not an internal counter: at a FIXED
// camera, a host stuck far over budget must end up drawing less geometry than it started
// with, and the same run with `adaptive=0` must not. A step counter could tick while the
// selector ignored it — the wire from controller to selection is exactly the seam #1402
// showed can silently go nowhere.
//
// SwiftShader is the right host for this by accident of being genuinely slow: frames here
// cost ~1-2 s, an order of magnitude over the 33.4 ms degrade bar, so the controller is
// under real sustained overload rather than a simulated one. It needs a full 12-frame
// window per notch, which is why the pump below is long and the timeout generous.
//
//   HEADED=0 XGIS_SOFTWARE_GPU=1 playwright test _adaptive-quality-ladder-gate.spec.ts

// z16 + steep pitch: the camera this lever is FOR. At low zoom the pitched frame still
// lies inside `FAR_RAMP_NEAR` (an earlier draft used z10.35 and measured a 0.6% change —
// correctly, because that scene has no far field to spend), so the gate has to stand
// where the horizon actually stretches.
const CAM = '#16/48.84778/2.33194/0/80'
const SOURCE = 'land'
/** 120 → 150 (#1433). The gate's premise is that the host genuinely cannot keep up, and at
 *  120 that was MARGINAL rather than assured: on a quiet runner the controller sometimes
 *  never judged a frame slow, never stepped a notch, and the gate then failed for having
 *  nothing to measure (`ladder bought 0.0%`) — reproduced locally 1 run in 2, and the shape
 *  of the 2026-07-28 CI red. 150 is +56% polygons, which puts the frame decisively over
 *  budget every run instead of near it. Raising the LOAD, not lowering the bar: every
 *  assertion below is unchanged. */
const SEED_GRID = 150
/** Degrees the seeded grid spans. Must cover the pitched view's FAR ground stretch, not
 *  just the foreground, or the lever has nothing out there to coarsen. */
const SEED_SPAN = 0.3

/** What the whole style drew last frame: how COARSE the tile set is (`coarsest` /
 *  `finest`, from the per-zoom drawn-tile histogram) plus the triangle and tile
 *  counts, which are REPORTED but never asserted on — see the note at the
 *  geometry assertion for why they cannot carry this claim. */
async function frameGeometry(page: Page): Promise<{
  tris: number
  tiles: number
  coarsest: number
  finest: number
  atFinest: number
  byZoom: string
}> {
  return await page.evaluate(() => {
    const pipe = (
      window as unknown as { __xgisMap?: { inspectPipeline(): unknown } }
    ).__xgisMap?.inspectPipeline() as
      | {
          sources?: Array<{
            frame: {
              triangles: number
              tilesVisible: number
              drawnByZoom: Array<[number, number]>
            }
          }>
        }
      | undefined
    let tris = 0
    let tiles = 0
    const merged = new Map<number, number>()
    for (const s of pipe?.sources ?? []) {
      tris += s.frame.triangles
      tiles += s.frame.tilesVisible
      for (const [z, n] of s.frame.drawnByZoom) merged.set(z, (merged.get(z) ?? 0) + n)
    }
    const zooms = [...merged.keys()].sort((a, b) => a - b)
    const finest = zooms[zooms.length - 1] ?? -1
    return {
      tris,
      tiles,
      coarsest: zooms[0] ?? -1,
      finest,
      atFinest: merged.get(finest) ?? 0,
      byZoom: JSON.stringify(zooms.map((z) => [z, merged.get(z)])),
    }
  })
}

/** Poll `frameGeometry` until the drawn-tile histogram AND the triangle count are identical
 *  across 3 consecutive samples, then return that reading — a settled geometry read instead
 *  of a guess at how long convergence takes (#1463).
 *
 *  The fixed 12 s / 4 s waits this replaces sampled the tile set mid-convergence: the SAME
 *  commit read a settled control of 20008 on one host and 28794 on another, because the two
 *  arms were not sampled at the same point on their load curves — `bought -43.9%`, a number a
 *  working ladder cannot produce either way. Polling for stability rather than fixed durations
 *  is what #1779 already did for the reseed gate's `settle()`; this is the same fix applied
 *  here.
 *
 *  Bounded at 90 s: this gate's own frames cost ~1-2 s under SwiftShader (see the file header),
 *  so 90 s is dozens of samples rather than a hair trigger, and a genuine hang must still fail
 *  loudly instead of silently reporting a moving target as settled. */
async function settleGeometry(
  page: Page,
  label: string,
  stableFor = 3,
  capMs = 90_000,
): Promise<Awaited<ReturnType<typeof frameGeometry>>> {
  const t0 = Date.now()
  let last: Awaited<ReturnType<typeof frameGeometry>> | undefined
  let stable = 0
  while (Date.now() - t0 < capMs) {
    await page.waitForTimeout(500)
    const g = await frameGeometry(page)
    stable = last && g.byZoom === last.byZoom && g.tris === last.tris ? stable + 1 : 0
    last = g
    if (stable >= stableFor) return g
  }
  throw new Error(
    `${label} arm never converged: last byZoom ${last?.byZoom ?? '(none)'}, tris ${last?.tris ?? -1} ` +
      `after ${capMs}ms — the tile set was still moving when the cap hit. That is an ENVIRONMENT ` +
      `result, not a regression: raise capMs or investigate why the loader never settles.`,
  )
}

/** How many notches DOWN the controller currently is, straight from the controller (#1433).
 *  This is the premise "the host cannot keep up", read at its source: the ladder steps off
 *  RENDERED-frame intervals, the only signal that includes the GPU work this thread merely
 *  submits. `pump`'s rAF median cannot see that — it measures the compositor's 60 Hz tick —
 *  which is how the old precondition ended up compared against a bar equal to its own floor. */
async function adaptiveStep(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const pipe = (
      window as unknown as { __xgisMap?: { inspectPipeline(): unknown } }
    ).__xgisMap?.inspectPipeline() as { adaptive?: { step: number } } | undefined
    return pipe?.adaptive?.step ?? -1
  })
}

/** Drive `n` real frames and return the median interval (ms). Reported, never asserted on —
 *  see `adaptiveStep`. */
async function pump(page: Page, n: number): Promise<number> {
  return await page.evaluate(async (count) => {
    const m = (window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap
    const out: number[] = []
    for (let i = 0; i < count; i++) {
      const t0 = performance.now()
      m?.invalidate?.()
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      out.push(performance.now() - t0)
    }
    out.sort((a, b) => a - b)
    return out[out.length >> 1] ?? -1
  }, n)
}

async function seed(page: Page): Promise<number> {
  return await page.evaluate(
    ({ grid, sourceId, span }) => {
      const ring = 24,
        lon = 2.33194,
        lat = 48.84778
      const step = span / grid,
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
    { grid: SEED_GRID, sourceId: SOURCE, span: SEED_SPAN },
  )
}

/** Load the demo, seed it, settle, then pump at a FIXED camera until the controller has had
 *  a real chance to act. `frames` is ONE pump round; the treatment arm keeps pumping while
 *  the ladder is still at notch 0, up to `MAX_ROUNDS`.
 *
 *  Rounds rather than one fixed count (#1433): a notch costs the controller a full 12-frame
 *  window of RENDERED frames, and a borderline host can spend most of a round just filling
 *  that window. One 40-frame pump therefore asked "did it step in time", not "will it step" —
 *  and answered no often enough to redden the leg. */
const MAX_ROUNDS = 4
async function run(
  page: Page,
  adaptive: boolean,
  frames: number,
): Promise<{
  before: number
  /** Triangles, visible tiles, AND the per-zoom drawn-tile histogram — see `frameGeometry`. */
  after: Awaited<ReturnType<typeof frameGeometry>>
  medMs: number
  step: number
  /** The far-field multiplier that reached the selector, not just the one computed. */
  farLodBoost: number
  /** The controller's own median RENDERED-frame interval (ms), off `stats.ts` — reported
   *  alongside `medMs` (the rAF-turn median `pump` measures) for diagnosis only; neither is
   *  asserted on (#1753). */
  ctrlMedianMs: number
  rounds: number
}> {
  await page.setViewportSize({ width: 430, height: 715 })
  const flags = adaptive ? '' : '&adaptive=0'
  await page.goto(`/demo.html?id=physical_map&forcegl2=1&e2e=1${flags}${CAM}`, {
    waitUntil: 'load',
  })
  await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady, {
    timeout: 60_000,
  })
  // Pin the backend BOTH arms ran on (#1444, CLAUDE.md §5). `?forcegl2=1` is a request; a
  // silent fall back to another chain would still reach every assertion below and green
  // them, and the two arms would then be comparing different renderers rather than
  // different notches. Asserted per arm, not once, because each is its own `page.goto`.
  expect(
    await page.evaluate(
      () => (window as unknown as { __xgisActiveBackend?: string }).__xgisActiveBackend,
    ),
    `?forcegl2=1 did not take on the adaptive=${adaptive ? 1 : 0} arm`,
  ).toBe('webgl2')
  await page.waitForTimeout(12_000)
  expect(await seed(page)).toBe(SEED_GRID * SEED_GRID)

  const before = (await settleGeometry(page, `adaptive=${adaptive ? 1 : 0} pre-pump`)).tris
  let medMs = await pump(page, frames)
  let rounds = 1
  // Extra rounds ONLY while the ladder is still at notch 0, so a run that steps in round 1 —
  // the normal case — costs exactly what it always did. Only the treatment arm can step at
  // all (`adaptive=0` pins it), so the control arm always runs one round.
  //
  // Deliberately NOT "pump until the notch settles". Measured: settling reaches notch 6 and
  // 28.6% coarsening but takes 3.4 min against 2.2, and the extra margin is not what fixes
  // this gate — the premise assertion is. The notch is now logged, so the spread the old runs
  // showed (14.1% at notch 1, 28.6% deeper down) reads as what it is, a rung, rather than as
  // unexplained noise.
  while (adaptive && rounds < MAX_ROUNDS && (await adaptiveStep(page)) === 0) {
    medMs = await pump(page, frames)
    rounds++
  }
  const after = await settleGeometry(page, `adaptive=${adaptive ? 1 : 0} post-pump`)
  // `step` and `farLodBoost` in ONE evaluate, off ONE inspection — read separately they can
  // straddle a frame and report a notch that never had that boost.
  const ad = await page.evaluate(() => {
    const pipe = (
      window as unknown as { __xgisMap?: { inspectPipeline(): unknown } }
    ).__xgisMap?.inspectPipeline() as
      { adaptive?: { step: number; farLodBoost: number; medianFrameMs: number } } | undefined
    return {
      step: pipe?.adaptive?.step ?? 0,
      farLodBoost: pipe?.adaptive?.farLodBoost ?? 1,
      medianFrameMs: pipe?.adaptive?.medianFrameMs ?? -1,
    }
  })
  return {
    before,
    after,
    medMs,
    step: ad.step,
    farLodBoost: ad.farLodBoost,
    ctrlMedianMs: ad.medianFrameMs,
    rounds,
  }
}

test.describe.configure({ mode: 'serial' })

test('the ladder trades far-field geometry for frame time under sustained overload (#1393)', async ({
  page,
}) => {
  test.setTimeout(15 * 60_000)

  // The comparison is CONTROL-FINAL vs TREATMENT-FINAL, not each arm's own before/after.
  // A freshly seeded source is still settling while the pump runs — the re-seed's refresh
  // queue drains across frames — so within one arm the tile set legitimately moves, and an
  // earlier draft of this gate failed on exactly that (control drifted +23% on its own).
  // Both arms settle the same way from the same fixture at the same camera; what differs
  // is only whether the controller is allowed to act.
  //
  // Deliberately NOT asserted: that the two arms agree at `before` (#1479 proposed it). The
  // treatment arm may already have notched during its own 24 s settle — measured, it has
  // done so on a slower host — and then a legitimately-different `before` would redden a
  // working ladder. `before` is reported for diagnosis and nothing rests on it.
  const off = await run(page, false, 40)
  // Report each arm BEFORE asserting on it (#1433). When the premise failed on CI it printed
  // nothing at all — the numbers were only logged after the treatment arm, which never ran —
  // so the red said "regression" about what was actually a measurement problem.
  console.log(
    `\n  adaptive=0  tris ${off.before} -> ${off.after.tris}, tiles ${off.after.tiles}` +
      ` z${off.after.coarsest}..${off.after.finest} ${off.after.byZoom},` +
      ` med ${off.medMs.toFixed(1)} ms, notch ${off.step}, ctrlMedianMs ${off.ctrlMedianMs.toFixed(1)}`,
  )
  expect(off.after.tris, 'the control must be drawing real geometry').toBeGreaterThan(10_000)
  expect(off.step, '`adaptive=0` must pin the ladder at notch 0').toBe(0)

  const on = await run(page, true, 40)
  console.log(
    `  adaptive=1  tris ${on.before} -> ${on.after.tris}, tiles ${on.after.tiles}` +
      ` z${on.after.coarsest}..${on.after.finest} ${on.after.byZoom},` +
      ` med ${on.medMs.toFixed(1)} ms, notch ${on.step}, ctrlMedianMs ${on.ctrlMedianMs.toFixed(1)}` +
      ` (${on.rounds} pump round${on.rounds === 1 ? '' : 's'})` +
      ` at farLodBoost ${on.farLodBoost}` +
      `\n  ladder coarsened the horizon by ${off.after.coarsest - on.after.coarsest} zoom level(s)` +
      ` and bought ${(100 * (1 - on.after.tiles / off.after.tiles)).toFixed(1)}% of the visible TILES` +
      `; triangles ${off.after.tris} -> ${on.after.tris} (NOT a pass/fail signal — see the gate)\n`,
  )

  // THE PREMISE, read from the controller itself (#1433 option 2). The gate is an experiment
  // on a host that cannot keep up; if the controller never judged a frame too slow, the
  // experiment did not run and the geometry assertion below would report an ENVIRONMENT as a
  // REGRESSION — which is exactly what the 2026-07-28 CI red did (27497 vs 27497).
  //
  // This replaces the old `off.medMs > 33.4`, which inferred load from the wall time of two
  // rAF turns: a quantity whose 60 Hz floor (2 × 16.6̄ = 33.3 ms) is numerically the bar it
  // was compared against, and which measured 33.39999999999418 (red), 33.4 (green) and 34.3
  // (green) on identical code. The notch is the controller's own verdict, taken from
  // RENDERED-frame intervals — the only signal that includes the GPU work this thread merely
  // submits — so it cannot disagree with the behaviour under test the way rAF cadence did.
  expect(
    on.step,
    `the controller never left notch 0 after ${on.rounds} pump rounds — this host kept up, so ` +
      `there was no overload to observe. That is an ENVIRONMENT result, not a regression: ` +
      `raise SEED_GRID (currently ${SEED_GRID}) or MAX_ROUNDS until the frame is decisively ` +
      `over budget here.`,
  ).toBeGreaterThan(0)

  // THE LEVER, asserted BEFORE any of its consequences (#1444). The wire this gate watches
  // has two halves that fail for different reasons — the controller's lever going dead
  // (`adaptiveFarLodBoost()`), and the selector ignoring a live one — and a gate is only
  // worth its run time if a red run says WHICH (§12, the 2026-07-28 autopsy).
  //
  // Order is what makes that true, and it is the whole point of this line's position.
  // Measured with `adaptiveFarLodBoost()` cut to a constant 1: with this assertion sitting
  // BELOW the coarsest-zoom one (where #1482 first put it), the run died on `the selector
  // never coarsened the horizon … the notch reached no tile` — accusing the half that was
  // still intact, because a dead lever and an ignored one produce the SAME tile histogram
  // and the first assertion to run is the one that reports. The comment that shipped with
  // it claimed a lever cut "fails HERE, naming the wire"; it could not, because control
  // never got here. Intent in a comment is not wiring — assert the CAUSE before the EFFECT.
  expect(
    on.farLodBoost,
    `the ladder stepped to notch ${on.step} but its far-field lever never engaged ` +
      `(farLodBoost ${on.farLodBoost}) — the controller's own multiplier never reached the ` +
      `map, so nothing downstream could have honoured it. This is the CONTROLLER half of the ` +
      `wire; the selector half is asserted below and is not implicated by this failure.`,
  ).toBeGreaterThan(1)

  // THE CLAIM: it acted, and the selector HONOURED it. A step counter can tick while the
  // selection ignores it — the wire this gate exists for (#1402 showed that seam go nowhere).
  //
  // Asserted on the COARSEST DRAWN ZOOM, not on the triangle count (#1479). Triangles cannot
  // carry this claim, and the reason is structural rather than a matter of tuning: this
  // fixture seeds 22 500 identical polygons uniformly over the ground and nothing generalises
  // them by zoom, so a tile's triangle count scales with the GROUND AREA it spans. Coarsening
  // replaces fine tiles with a coarser ancestor covering 4x the ground, which therefore
  // carries MORE geometry than the tiles it replaced. Measured on `main` at the moment of
  // filing: the ladder correctly collapsed the far-field pair z13x2 into a single z12 while
  // leaving the four z14 foreground tiles untouched — and triangles rose 20 008 -> 28 794,
  // reddening this gate with `ladder bought -43.9%` while the feature worked perfectly.
  //
  // Zoom cannot invert that way: coarsening IS a lower drawn zoom, by definition. It also
  // fails honestly if the wire dies — the notch moves and the histogram does not.
  //
  // The mean drawn zoom was rejected: it is dominated by the unchanged foreground (13.667 ->
  // 13.600 on the same run, a 0.5% signal), so a real one-level coarsening would sit inside
  // any tolerance wide enough to be safe.
  //
  // Reaching this line means the lever assertion above already passed, so `farLodBoost` is
  // live and this failure can only be the SELECTOR half — which is what its message says.
  expect(
    on.after.coarsest,
    `the controller stepped to notch ${on.step} and its lever reached the map (farLodBoost ` +
      `${on.farLodBoost}), but the selector never coarsened the horizon (control drew ` +
      `${off.after.byZoom}, adaptive drew ${on.after.byZoom}) — the notch reached no tile. ` +
      `This is the SELECTOR half of the wire. Triangles are NOT the signal here ` +
      `(${off.after.tris} -> ${on.after.tris}); see the comment above.`,
  ).toBeLessThan(off.after.coarsest)

  // Fewer TILES corroborates it (#1482). A shallower coarsest zoom with the SAME tile count
  // would mean the selector ADDED a coarse tile rather than replacing finer ones with it —
  // which is not coarsening. Measured: 6 tiles -> 5, as the z13 pair became one z12.
  expect(
    on.after.tiles,
    `the controller stepped to notch ${on.step} (farLodBoost ${on.farLodBoost}) but the ` +
      `selector kept the same horizon (control ${off.after.tiles} tiles, adaptive ${on.after.tiles})`,
  ).toBeLessThan(off.after.tiles)

  // …and what it took must be the FAR field: the foreground guarantee #1374 restored has to
  // survive every notch. Pinned exhaustively over the ladder's own values in
  // map/src/render/sse-foreground-lod.test.ts; end-to-end, the observable is that the FINEST
  // drawn zoom is untouched while the coarsest dropped. This is the half the old triangle
  // assertion could not express at all — a ladder that coarsened the foreground instead of
  // the horizon would have satisfied it just as well.
  expect(
    on.after.finest,
    `the ladder spent the FOREGROUND, not the horizon: finest drawn zoom fell from ` +
      `${off.after.finest} to ${on.after.finest} (control ${off.after.byZoom}, adaptive ` +
      `${on.after.byZoom})`,
  ).toBe(off.after.finest)

  // The finest ZOOM surviving is not enough on its own: a ladder that kept one z14 tile and
  // dropped the other three would satisfy it while having spent exactly the foreground the
  // #1374 guarantee protects. So the COUNT at that zoom is pinned too. Measured, both arms
  // draw the same four z14 tiles; only the far field moves.
  expect(
    on.after.atFinest,
    `the ladder thinned the FOREGROUND: ${off.after.atFinest} -> ${on.after.atFinest} tiles at ` +
      `z${off.after.finest} (control ${off.after.byZoom}, adaptive ${on.after.byZoom})`,
  ).toBe(off.after.atFinest)

  // …and the map is still drawing, not blanked.
  expect(on.after.tris, 'the ladder must coarsen the horizon, not empty the map').toBeGreaterThan(0)
})
