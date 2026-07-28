// ═══ The catalogue arrows ARE the particles — rendered (#1419) ═══
//
// On WebGl2Device under headless SwiftShader, the same software rasteriser the CI render-gate
// leg drives. "No GPU here" was only ever true of WebGPU.
//
// TWO CLAIMS, and the second one is the one a look cannot make for you.
//
//  A. FRAME 0 OF THE ADVECTED FIELD IS THE STATIC CATALOGUE PLACEMENT. The origins seed the
//     position state (arrow-advect-state.ts), so before the arrows have drifted anywhere the
//     advected path must draw what `| arrow` draws — same cells, same band colours, same
//     per-band sizes. That makes this a PARITY claim between two independent implementations of
//     one catalogue rule: `| arrow` bakes colour and size on the CPU from `bandedRampColor` +
//     `s111ArrowScale`, while the advected VS looks them up on the GPU from the uploaded band
//     table, at a position it decoded from a texture. Agreement is evidence the table, the
//     normalization by peak speed, the scale rule and the origin encoding are all right; a
//     silent error in any one of them shows up here as a field that does not match.
//
//  B. THEN THEY MOVE. The drifted frame must differ from that frame-0 field by MUCH more than
//     the same-code noise floor, which is measured rather than assumed.
//
// WHY NOT A PIXEL COUNT: a painted-fraction gate passes on broken images (§12) — a field frozen
// at its origins and a field of arrows drawn at garbage positions have the same count. Both
// assertions below are RATIOS against a measured baseline, so what is claimed is a direction.
//
// WHAT THIS DELIBERATELY DOES NOT CLAIM: that an arrow's colour changes as it crosses a band
// edge. That needs a field whose speed ramps ALONG its own flow, and this fixture's tidal field
// has no such known gradient — over a steady-state field the colour histogram is stationary, so
// measuring it would be a tripwire, not a verdict. The "colour follows the CURRENT position"
// half is instead proven by construction in arrow-retained-dsl.test.ts, which traces the emitted
// WGSL from the band lookup back to the decoded state position and is verified by mutation.

import { test, expect } from '@playwright/test'

const ZOOM = 7
const CENTRE_LAT = 38.1
const CENTRE_LON = -76.19

/** One layer over the demo's declared synthetic coverage, and nothing else — no basemap, so
 *  every painted pixel below is an arrow. `| arrow` is the static catalogue portrayal;
 *  `| flow` resolves to the ADVECTED arrows portrayal (#1418's default). */
const style = (layer: '| arrow' | '| flow'): string => `xgis 1

source currents {
  type: coverage
  url: "synthetic-currents.h5"
}

layer speed {
  source: currents
  ${layer}
}
`

/** The live drawing buffer, downsampled to a fixed grid of painted/not cells. A coarse grid
 *  rather than raw pixels: it is what makes "the same arrows in the same places" comparable
 *  across two independent code paths without asserting sub-pixel identity neither path
 *  promises. */
function readGrid() {
  const w = window as unknown as {
    __xgisMap?: { ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } } }
  }
  const gl = w.__xgisMap?.ctx?.rhi?.gl
  if (!gl) return { ok: false as const, reason: 'no gl' }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  const buf = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  const N = 96 // cells per axis
  const cells = new Float64Array(N * N)
  const counts = new Float64Array(N * N)
  let painted = 0
  for (let y = 0; y < H; y++) {
    const cy = Math.min(N - 1, Math.floor((y / H) * N))
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const r = buf[i]!
      const g = buf[i + 1]!
      const b = buf[i + 2]!
      const cx = Math.min(N - 1, Math.floor((x / W) * N))
      const c = cy * N + cx
      counts[c]! += 1
      if (r > 24 || g > 24 || b > 24) {
        painted++
        // Carry the COLOUR, not just coverage: two fields can cover the same cells and still
        // disagree about which speed band is there, which is exactly the failure that looks
        // like a working animation.
        cells[c]! += (r + 2 * g + 4 * b) / 7
      }
    }
  }
  for (let c = 0; c < cells.length; c++) cells[c]! /= Math.max(1, counts[c]!)
  return {
    ok: true as const,
    backend: w.__xgisMap?.ctx?.rhi?.backend,
    W,
    H,
    painted: painted / (W * H),
    cells: Array.from(cells),
  }
}

/** Mean absolute per-cell difference — the directional metric both claims are stated in. */
const diff = (a: number[], b: number[]): number => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!)
  return s / a.length
}

async function boot(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 900, height: 700 })
  // The basemap would paint every pixel and make every metric here vacuous — the claim is
  // about ARROWS. A regex, not a glob: the host is one path segment (see #1272's spec).
  await page.route(/arcgisonline\.com/, (r) => void r.abort())
  // `adaptive=0` PINS THE RESOLUTION, and without it this whole gate is a tripwire. The
  // advected field animates every frame, so the adaptive quality ladder (#1406) reads the
  // sustained load and steps DPR down — measured here: 1 → 0.72 → 0.5 within three seconds.
  // Every pixel then changes for a reason that has nothing to do with arrows moving, which
  // would let "the field changed" pass over a field frozen at its origins. It also makes the
  // glyphs look like formless blobs at full zoom, which is a resolution artifact and not a
  // shape bug — worth stating, because it is exactly what the first run of this looked like.
  await page.goto(
    `/demo.html?id=s111_currents&forcegl2=1&e2e=1&adaptive=0#${ZOOM}/${CENTRE_LAT}/${CENTRE_LON}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 20000 },
  )
}

/** Swap the running style, then wait for the coverage to be resident again. */
async function run(page: import('@playwright/test').Page, src: string) {
  await page.evaluate(async (s) => {
    const w = window as unknown as { __xgisRunSource?: (s: string) => Promise<unknown> }
    await w.__xgisRunSource!(s)
  }, src)
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __xgisMap?: { getCoverage(id: string): unknown } }
      ).__xgisMap?.getCoverage('currents') != null,
    { timeout: 20000 },
  )
}

test.describe('S-111 advected arrows (#1419)', () => {
  test('frame 0 IS the catalogue placement, and then the arrows move', async ({ page }) => {
    test.setTimeout(180_000)
    await boot(page)

    // ── The static catalogue field, twice: the reference AND the same-code noise floor. ──
    await run(page, style('| arrow'))
    await page.waitForTimeout(1500)
    const staticA = await page.evaluate(readGrid)
    expect(staticA.ok, 'WebGL2 context present').toBe(true)
    if (!staticA.ok) return
    expect(staticA.backend, 'running on the WebGL2 backend, not a silent fallback').toBe('webgl2')
    // A vacuous frame would make every comparison below trivially zero.
    expect(staticA.painted, 'the static arrow field actually rasterises').toBeGreaterThan(0.005)
    await page.waitForTimeout(1200)
    const staticB = await page.evaluate(readGrid)
    if (!staticB.ok) return
    const floor = diff(staticA.cells, staticB.cells)
    await page.screenshot({ path: 'test-results/s111-advected-static.png' })

    // ── The advected field, read as soon as it is resident: the arrows are still at home. ──
    await run(page, style('| flow'))
    await page.waitForTimeout(400)
    const adv0 = await page.evaluate(readGrid)
    if (!adv0.ok) return
    expect(adv0.painted, 'the advected field rasterises too').toBeGreaterThan(0.005)
    await page.screenshot({ path: 'test-results/s111-advected-frame0.png' })

    // ── …and again after it has had time to drift. ──
    await page.waitForTimeout(3000)
    const advN = await page.evaluate(readGrid)
    if (!advN.ok) return
    await page.screenshot({ path: 'test-results/s111-advected-drifted.png' })

    const parity = diff(staticA.cells, adv0.cells)
    const moved = diff(adv0.cells, advN.cells)
    console.log(
      `[s111-advected] floor=${floor.toFixed(4)} parity(static↔adv0)=${parity.toFixed(4)} ` +
        `moved(adv0↔advN)=${moved.toFixed(4)} painted static=${staticA.painted.toFixed(4)} ` +
        `adv=${adv0.painted.toFixed(4)}`,
    )

    // CLAIM B — the arrows moved, by much more than the same-code noise floor. Stated first
    // because it is the precondition for A meaning anything: if nothing moved, A would pass by
    // drawing a frozen field.
    expect(moved, 'the advected field changed between frames').toBeGreaterThan(
      Math.max(floor * 4, 0.5),
    )

    // CLAIM A — frame 0 of the advected field is the static catalogue placement. Stated as a
    // RATIO against how far the field travels, not as an absolute: the two paths agree about
    // cells, colours and sizes far more closely than the animation displaces them.
    expect(parity, 'frame 0 matches the catalogue portrayal').toBeLessThan(moved * 0.75)
  })
})
