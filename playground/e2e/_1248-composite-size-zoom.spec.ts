// #1248 — a composite `size-[step(.w, …) * interpolate(zoom, …)]` binding
// tracks the camera zoom LIVE on the vector-tile point path: geojson sources
// (inline or url) tile through VirtualPMTiles, and `flushTilePointsRhi`
// re-evaluates `show.sizeExpr` per feature EVERY FRAME with the live
// `cameraZoom` in the eval props (point-renderer.ts). This spec pins that
// behaviour so a future refactor that freezes the product at layer build (the
// legacy direct `addLayer` path evaluates per-feature sizes once) reddens.
//
// Scene: three points with .w = 1/2/3 → step radii 6/10/14, ramp 0.5@z1 → 1@z4.
// At z2 (ramp 0.666) and z4 (ramp 1) each dot's measured diameter must grow by
// ≈ ×1.5 while the per-feature ordering d(w3) > d(w2) > d(w1) holds at BOTH
// zooms — flat sizes (dropped feature tiers) or frozen sizes (dead ramp) both
// redden.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '__1248-composite-size__')

const SRC = `xgis 1

source pts {
  type: geojson
  data: { "type": "FeatureCollection", "features": [
    { "type": "Feature", "properties": { "w": 1 }, "geometry": { "type": "Point", "coordinates": [-10, 0] } },
    { "type": "Feature", "properties": { "w": 2 }, "geometry": { "type": "Point", "coordinates": [0, 0] } },
    { "type": "Feature", "properties": { "w": 3 }, "geometry": { "type": "Point", "coordinates": [10, 0] } }
  ] }
}

layer dots {
  source: pts
  | fill-rose-500
  | size-[step(.w, 6, 2, 10, 3, 14) * interpolate(zoom, 1, 0.5, 4, 1)]
}
`

type Win = Window & {
  __xgisReady?: boolean
  __xgisMap?: {
    invalidate?: () => void
    markCameraPositioned?: () => void
    project?: (p: [number, number]) => [number, number] | null
    getCamera?: () => { zoom: number; maxZoom: number; centerX: number; centerY: number }
  }
}

const LONS = [-10, 0, 10]

async function setZoom(page: import('@playwright/test').Page, z: number): Promise<void> {
  await page.evaluate((zoom) => {
    const m = (window as unknown as Win).__xgisMap!
    const c = m.getCamera!()
    c.zoom = zoom
    c.centerX = 0
    c.centerY = 0
    m.markCameraPositioned?.()
    m.invalidate?.()
  }, z)
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

/** How long the rendered sizes are given to stop changing, and how often to look.
 *
 *  MEASURED, and the second round of measurement CORRECTED the first — recorded here
 *  because the correction is the whole reason the predicate below has two signals.
 *
 *  Round 1 replaced a hardcoded `waitForTimeout(2000)` with "two consecutive equal,
 *  non-zero diameter reads". It passed 3/3 locally and STILL FLAKED ON CI, reporting
 *  `settled=true` on the wrong value:
 *
 *      CI, failing attempt   Z2 [6,12,18]  settled=true polls=2  977 ms
 *      CI, retry             Z2 [9,14,20]  settled=true polls=2 1068 ms
 *      local                 Z2 [8,14,19]  settled=true polls=3 2100-3300 ms
 *
 *  Two equal reads detect MOMENTARY stability, not convergence. CI's screenshot+measure
 *  round-trip is faster than this box's, so it reached its second poll at 977 ms —
 *  early enough in the page's life to catch a plateau and call it settled. A predicate
 *  sampling one quantity can always be outrun by a fast sampler on a slow page.
 *
 *  Hence a SECOND, independent signal: the map's own `contentGeneration`. Traced locally
 *  per poll, it moves on its own schedule and is not derivable from the pixels:
 *
 *      run A  poll1 d=[0,0,0]   gen=0  inFlight=4
 *             poll2 d=[0,0,0]   gen=37 inFlight=0     <- diameters EQUAL, gen moved
 *             poll3 d=[8,14,19] gen=37
 *             poll4 d=[8,14,19] gen=37                <- both stable: settled
 *      run B  poll1 d=[0,0,0]   gen=33
 *             poll2 d=[8,14,19] gen=37                <- both moved
 *             poll3 d=[8,14,19] gen=37                <- both stable: settled
 *
 *  Run A's poll1/poll2 is also the case the all-positive guard exists for, caught in the
 *  act: two EQUAL reads of [0,0,0] while the scene was still loading. That guard was
 *  documented as unproven in round 1 — this trace is the proof, so it now stays on
 *  evidence rather than on caution.
 *
 *  HONEST LIMIT, stated because round 1 was over-claimed and CI collected the bill:
 *  the gen conjunct is strictly stronger BY CONSTRUCTION — a conjunction can only delay
 *  settling, never advance it — and CI's 977 ms exit sits far inside the 1500-2500 ms
 *  this box needs for gen to stabilise, so it very likely blocks that exact plateau.
 *  It is NOT proven to. Two things are true and neither is proof:
 *    - the failing CI run predates the gen probe, so gen at that moment is unknown;
 *    - CUTTING the gen conjunct here changes no local outcome (same 3 polls, 2/2 runs),
 *      because the diameter conjunct is always the binding one on this box. So gen is
 *      unexercised locally, exactly as the all-positive guard was until the trace above
 *      caught it firing.
 *  `gen` is therefore logged on the Z2/Z4 line. The next CI run states which half held,
 *  which is what makes a third round a measurement rather than another guess.
 *
 *  45 s is a "something is actually broken" ceiling, not a tuned wait: ~10x the slowest
 *  loop seen here, absorbing the ~10x CI slowdown the dateline gate showed (#1924), and
 *  still leaving ~150 s of this test's own 240 s budget. */
const SETTLE_BUDGET_MS = 45_000
const SETTLE_POLL_MS = 200

/** The map's own "the scene changed" counter, summed over attached catalogs — the same
 *  quantity `_1616-content-generation-churn` watches. Read as a SECOND, independent
 *  stability signal, because the measured diameters alone are not enough (see below). */
const readGen = (page: import('@playwright/test').Page): Promise<number> =>
  page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: {
          vtSources?: Map<string, { source?: { contentGeneration?: () => number } }>
        }
      }
    ).__xgisMap
    let gen = 0
    for (const [, v] of m?.vtSources ?? []) gen += v.source?.contentGeneration?.() ?? 0
    return gen
  })

interface Settled {
  png: Buffer
  diameters: number[]
  /** false = the budget expired with the reads still moving. The caller must fail on
   *  this rather than assert on the last read, so a timeout accuses itself instead of
   *  the ramp (#1924: a gate that blames a mechanism for a state it cannot distinguish
   *  sends the next person to the wrong file). */
  settled: boolean
  /** The content generation at the settling read. LOGGED so the next CI run can decide
   *  whether the gen half of the predicate was what held, instead of guessing again. */
  gen: number
  polls: number
  ms: number
  /** The last two reads, for the failure message. */
  tail: [number[], number[]]
}

/** Set the camera, then wait for the RENDERED dot diameters to stop changing.
 *
 *  This replaces a fixed `waitForTimeout(2000)`, which was the flake in #1924. Two
 *  rAFs prove a frame was PRESENTED; they prove nothing about the zoom ramp having
 *  been re-resolved for the new zoom. On a loaded CI shard the z2 capture landed
 *  mid-transition: the failing attempt read [6,12,18] where the settled value is
 *  [9,14,20] — SMALLER, because the demo starts below z2 and the dots are still
 *  growing — which put dot 0's z4/z2 ratio at 13/6 = 2.17 against the 1.9 ceiling.
 *  The smallest dot is the most sensitive probe (6->9 is a 50% relative move, 18->20
 *  is 11%), which is why exactly one of the three breached while z4 was byte-identical
 *  across both attempts.
 *
 *  Convergence on the quantity the assertions actually read — two consecutive equal
 *  measurements — not a bigger sleep. A bigger sleep only moves the same failure later.
 *
 *  The all-positive guard is load-bearing, and observed firing: a poll pair of
 *  [0, 0, 0] / [0, 0, 0] is traced above. Without it the loop reports settled with
 *  nothing drawn, and the tier assertion then fails accusing the ramp — the
 *  misattribution #1924 is about. */
async function settleAndMeasure(
  page: import('@playwright/test').Page,
  z: number,
): Promise<Settled> {
  await setZoom(page, z)
  const t0 = Date.now()
  let prev: number[] = []
  let prevGen = -1
  let png = Buffer.alloc(0)
  let diameters: number[] = []
  let gen = -1
  let polls = 0
  let settled = false
  for (;;) {
    png = await page.locator('#map').screenshot()
    diameters = await measureDiameters(page, png)
    gen = await readGen(page)
    polls++
    if (
      diameters.length === LONS.length &&
      diameters.every((v) => v > 0) &&
      diameters.every((v, i) => v === prev[i]) &&
      gen === prevGen
    ) {
      settled = true
      break
    }
    if (Date.now() - t0 > SETTLE_BUDGET_MS) break
    prev = diameters
    prevGen = gen
    await page.waitForTimeout(SETTLE_POLL_MS)
  }
  return { png, diameters, gen, settled, polls, ms: Date.now() - t0, tail: [prev, diameters] }
}

/** Diameter of each dot: the contiguous rose run along the row through the
 *  dot's projected centre (device px). */
async function measureDiameters(
  page: import('@playwright/test').Page,
  png: Buffer,
): Promise<number[]> {
  const centers = await page.evaluate((lons) => {
    const m = (window as unknown as Win).__xgisMap!
    return lons.map((lon) => m.project!([lon, 0]))
  }, LONS)
  return page.evaluate(
    async ({ b64, centers }) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
      const canvasEl = document.getElementById('map') as HTMLCanvasElement
      const cssW = canvasEl.getBoundingClientRect().width
      const scale = bmp.width / cssW
      const isRose = (x: number, y: number): boolean => {
        if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return false
        const i = (y * bmp.width + x) * 4
        return d[i] > 190 && d[i + 1] < 120 && d[i + 2] < 150 && d[i] - d[i + 1] > 80
      }
      return (centers as ([number, number] | null)[]).map((p) => {
        if (!p) return 0
        const cx = Math.round(p[0] * scale)
        const cy = Math.round(p[1] * scale)
        // Scan the centre row (±2 rows for AA robustness) for the widest run
        // covering cx.
        let best = 0
        for (let dy = -2; dy <= 2; dy++) {
          const y = cy + dy
          if (!isRose(cx, y)) continue
          let left = cx
          while (isRose(left - 1, y)) left--
          let right = cx
          while (isRose(right + 1, y)) right++
          best = Math.max(best, right - left + 1)
        }
        return best
      })
    },
    { b64: png.toString('base64'), centers },
  )
}

test('#1248 composite size tracks zoom live with per-feature tiers intact', async ({ page }) => {
  test.setTimeout(240_000)
  mkdirSync(OUT, { recursive: true })
  await page.setViewportSize({ width: 1100, height: 700 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

  const b64 = Buffer.from(SRC, 'utf8').toString('base64')
  await page.goto(`/demo.html?id=__import&e2e=1#src=${b64}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 30_000,
  })

  const low = await settleAndMeasure(page, 2)
  writeFileSync(join(OUT, 'z2.png'), low.png)
  const dLow = low.diameters
  console.log(
    `Z2 diameters: ${JSON.stringify(dLow)} (settled=${low.settled} polls=${low.polls} ${low.ms}ms gen=${low.gen})`,
  )

  const high = await settleAndMeasure(page, 4)
  writeFileSync(join(OUT, 'z4.png'), high.png)
  const dHigh = high.diameters
  console.log(
    `Z4 diameters: ${JSON.stringify(dHigh)} (settled=${high.settled} polls=${high.polls} ${high.ms}ms gen=${high.gen})`,
  )

  expect(errors, 'no page errors').toEqual([])
  // Asserted BEFORE the ratios: an unsettled read is not a wrong ramp, and saying so
  // here is what stops a slow shard from being reported as a size regression.
  for (const [name, r] of [
    ['z2', low],
    ['z4', high],
  ] as const) {
    expect(
      r.settled,
      `${name} diameters never settled in ${r.ms}ms (${r.polls} polls): ` +
        `${JSON.stringify(r.tail[0])} -> ${JSON.stringify(r.tail[1])}. ` +
        `The page kept re-rendering (or drew nothing) — this is NOT a ramp failure.`,
    ).toBe(true)
  }
  // Per-feature tiers hold at both zooms (scales not dropped).
  expect(dLow[2]).toBeGreaterThan(dLow[1])
  expect(dLow[1]).toBeGreaterThan(dLow[0])
  expect(dHigh[2]).toBeGreaterThan(dHigh[1])
  expect(dHigh[1]).toBeGreaterThan(dHigh[0])
  // The ramp is LIVE: z1→4 interpolates 0.5→1, so z2→z4 grows ≈ ×1.5
  // (0.666→1). Frozen sizes measure ratio ≈ 1. AA gives ±~2 px per edge, so
  // gate on a generous mid-band per dot.
  for (let i = 0; i < 3; i++) {
    const ratio = dHigh[i]! / Math.max(1, dLow[i]!)
    expect(
      ratio,
      `dot ${i} zoom ratio ${ratio.toFixed(2)} (z4 ${dHigh[i]}px / z2 ${dLow[i]}px)`,
    ).toBeGreaterThan(1.2)
    expect(ratio).toBeLessThan(1.9)
  }
})
