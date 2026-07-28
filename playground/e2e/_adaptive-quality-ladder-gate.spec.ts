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
const SEED_GRID = 120
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

/** Drive `n` real frames and return the median interval (ms). */
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

/** Load the demo, seed it, settle, then pump `frames` frames at a FIXED camera. */
async function run(
  page: Page,
  adaptive: boolean,
  frames: number,
): Promise<{ before: number; after: number; medMs: number }> {
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
  const medMs = await pump(page, frames)
  await page.waitForTimeout(4000)
  const after = (await frameGeometry(page)).tris
  return { before, after, medMs }
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
  expect(off.after, 'the control must be drawing real geometry').toBeGreaterThan(10_000)
  expect(off.medMs, 'the host must actually be over the 33.4 ms degrade bar').toBeGreaterThan(33.4)

  const on = await run(page, true, 40)
  console.log(
    `\n  adaptive=0  tris ${off.before} -> ${off.after}, med ${off.medMs.toFixed(1)} ms` +
      `\n  adaptive=1  tris ${on.before} -> ${on.after}, med ${on.medMs.toFixed(1)} ms` +
      `\n  ladder bought ${(100 * (1 - on.after / off.after)).toFixed(1)}% of the settled geometry\n`,
  )
  expect(
    on.after,
    `the ladder never coarsened the horizon (control settled at ${off.after}, adaptive at ${on.after})`,
  ).toBeLessThan(off.after * 0.9)

  // …and what it took must be the FAR field: the foreground guarantee #1374 restored has
  // to survive every notch. Pinned exhaustively over the ladder's own values in
  // map/src/render/sse-foreground-lod.test.ts; here the end-to-end check is simply that
  // the layer is still drawing, not blanked.
  expect(on.after, 'the ladder must coarsen the horizon, not empty the map').toBeGreaterThan(0)
})
