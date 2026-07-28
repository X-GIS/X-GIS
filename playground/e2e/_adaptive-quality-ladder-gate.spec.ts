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

/** Geometry the whole style contributed to the last frame. */
async function frameGeometry(page: Page): Promise<{ tris: number; tiles: number }> {
  return await page.evaluate(() => {
    const pipe = (
      window as unknown as { __xgisMap?: { inspectPipeline(): unknown } }
    ).__xgisMap?.inspectPipeline() as
      { sources?: Array<{ frame: { triangles: number; tilesVisible: number } }> } | undefined
    let tris = 0
    let tiles = 0
    for (const s of pipe?.sources ?? []) {
      tris += s.frame.triangles
      tiles += s.frame.tilesVisible
    }
    return { tris, tiles }
  })
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
): Promise<{ before: number; after: number; medMs: number; step: number; rounds: number }> {
  await page.setViewportSize({ width: 430, height: 715 })
  const flags = adaptive ? '' : '&adaptive=0'
  await page.goto(`/demo.html?id=physical_map&forcegl2=1&e2e=1${flags}${CAM}`, {
    waitUntil: 'load',
  })
  await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady, {
    timeout: 60_000,
  })
  await page.waitForTimeout(12_000)
  expect(await seed(page)).toBe(SEED_GRID * SEED_GRID)
  await page.waitForTimeout(12_000)

  const before = (await frameGeometry(page)).tris
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
  await page.waitForTimeout(4000)
  const after = (await frameGeometry(page)).tris
  return { before, after, medMs, step: await adaptiveStep(page), rounds }
}

test.describe.configure({ mode: 'serial' })

test('the ladder trades far-field geometry for frame time under sustained overload (#1393)', async ({
  page,
}) => {
  test.setTimeout(15 * 60_000)

  // The comparison is CONTROL-FINAL vs TREATMENT-FINAL, not each arm's own before/after.
  // A freshly seeded source is still settling while the pump runs — the re-seed's refresh
  // queue drains across frames — so within one arm the geometry legitimately GROWS, and an
  // earlier draft of this gate failed on exactly that (control drifted +23% on its own).
  // Both arms settle the same way from the same fixture at the same camera; what differs
  // is only whether the controller is allowed to act.
  const off = await run(page, false, 40)
  // Report each arm BEFORE asserting on it (#1433). When the premise failed on CI it printed
  // nothing at all — the numbers were only logged after the treatment arm, which never ran —
  // so the red said "regression" about what was actually a measurement problem.
  console.log(
    `\n  adaptive=0  tris ${off.before} -> ${off.after}, med ${off.medMs.toFixed(1)} ms, notch ${off.step}`,
  )
  expect(off.after, 'the control must be drawing real geometry').toBeGreaterThan(10_000)
  expect(off.step, '`adaptive=0` must pin the ladder at notch 0').toBe(0)

  const on = await run(page, true, 40)
  console.log(
    `  adaptive=1  tris ${on.before} -> ${on.after}, med ${on.medMs.toFixed(1)} ms, notch ${on.step}` +
      ` (${on.rounds} pump round${on.rounds === 1 ? '' : 's'})` +
      `\n  ladder bought ${(100 * (1 - on.after / off.after)).toFixed(1)}% of the settled geometry\n`,
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

  // THE CLAIM: it acted, and the selector HONOURED it. A step counter can tick while the
  // selection ignores it — the wire this gate exists for (#1402 showed that seam go nowhere).
  expect(
    on.after,
    `the controller stepped to notch ${on.step} but the horizon never coarsened ` +
      `(control settled at ${off.after}, adaptive at ${on.after})`,
  ).toBeLessThan(off.after * 0.9)

  // …and what it took must be the FAR field: the foreground guarantee #1374 restored has
  // to survive every notch. Pinned exhaustively over the ladder's own values in
  // map/src/render/sse-foreground-lod.test.ts; here the end-to-end check is simply that
  // the layer is still drawing, not blanked.
  expect(on.after, 'the ladder must coarsen the horizon, not empty the map').toBeGreaterThan(0)
})
