// ═══ The catalogue arrows ARE the particles — rendered (#1419) ═══
//
// On WebGl2Device under headless SwiftShader, the same software rasteriser the CI render-gate
// leg drives. "No GPU here" was only ever true of WebGPU.
//
// THE CONTRACT CHANGED WITH #1511, and this is where it is written down.
//
// This gate used to assert frame-0 parity at WHATEVER zoom it happened to be framed at, and that
// claim is now false — deliberately. The advected field no longer draws one arrow per cell: it is
// seeded on a lattice up to 8× finer per axis and thinned per frame by screen spacing, so at most
// zooms it draws a different set of positions than the catalogue portrayal does. #1450 settled
// that the density work ENDS the unconditional contract rather than preserving it, and asked that
// its INTENT survive: it is the only assertion that the advected path's colour, scale and
// placement come from the catalogue authorities rather than drifting into a private rule.
//
// It survives as a claim about a RUNG. The thinning keeps every 2^L-th node of the seeded lattice,
// the lattice contains the cell centres, and `L = log2(sub)` therefore keeps EXACTLY the cell
// centres. So there is a zoom band — entered when the cell spacing lands in [34, 68) px, which is
// z10 on this fixture — where the drawn set IS the catalogue placement, and the parity claim is
// exact there rather than approximately true everywhere.
//
// WHY THE PARITY IS NO LONGER ASSERTED PIXEL-FOR-PIXEL, and this is a MEASUREMENT, not a
// convenience. The old claim needed a frame in which the arrows had not yet moved. At the rung
// that frame is not reachable: the leash is 5% of the grid span, which at a zoom where cells are
// 36 px apart is 56 px — HALF AGAIN the spacing between arrows — so an arrow passes its own
// neighbour's position within the time a style swap takes to settle. Measured across read delays
// after residency, at the rung:
//
//     delay    0ms   60ms  150ms  400ms  1200ms  3000ms
//     parity   3.08  3.70   4.28   4.38    4.45    4.13     ← already saturated at zero
//
// while the painted fraction sits at 0.0213 against the catalogue field's 0.0218 at every one of
// them. The two fields draw the SAME AMOUNT in the same places-give-or-take-a-leash; what cannot
// be recovered is WHICH pixel. (At z7, where the old gate lived, the leash was 19% of the drawn
// spacing and the same read looked exact — that is why this worked before and cannot now.)
//
// So the claim is split, each half asserted where it can be EXACT rather than approximately:
//
//  • PLACEMENT moves to `coverage-arrow-show.test.ts`, which checks the actual origin set: the
//    lattice's level-0 rung — its nodes whose index is divisible by `sub` — IS the drawable cell
//    set, in the same order. Exact, no GPU, and no drift to out-run.
//  • COLOUR and SCALE stay HERE, because only a render can compare the CPU rule against the GPU
//    table, and both are drift-immune: the water is the same water wherever an arrow stands in it.
//
// THREE CLAIMS, and the second one is the one a look cannot make for you.
//
//  A. AT THE LEVEL-0 RUNG THE ADVECTED FIELD IS THE CATALOGUE FIELD — same number of arrows,
//     same ink, same colour distribution. That is a PARITY claim between two independent
//     implementations of one catalogue rule: `| arrow` bakes colour and size on the CPU from
//     `bandedRampColor` + `s111ArrowScale`, while the advected VS looks them up on the GPU from
//     the uploaded band table, at a position it decoded from a texture. Agreement is evidence the
//     table, the normalization by peak speed and the scale rule are all right — a wrong peak puts
//     every arrow in the wrong band, which moves both the ink (the scale rule) and the colour.
//
//     Note what this is NOT: a camera chosen because the density rule is switched off there. At
//     z10 the rule is running at full tilt — it keeps 1 node in 64 — and the set it keeps is the
//     catalogue's.
//
//  B. THEN THEY MOVE. The drifted frame must differ from the first-read field by MUCH more than
//     the same-code noise floor, which is measured rather than assumed.
//
//  C. THE RUNG IS A RUNG. One zoom out, the advected field must draw strictly FEWER arrows than
//     the catalogue field — otherwise A is being asserted somewhere the ladder does not move, and
//     a later camera change could quietly turn it back into the unconditional claim that #1450
//     retired.
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

/** THE LEVEL-0 RUNG, derived rather than hunted for. The cull targets the glyph's base length
 *  (34 px) and keeps powers of two, so the drawn spacing is held in [34, 68) px; the drawn set is
 *  the cell centres exactly when the CELL spacing is itself in that band.
 *
 *  This fixture's tighter axis is 0.025° lon ≈ 2 189 m, and X-GIS's zoom is a 512-px-tile one
 *  (`TILE_PX = 512`, so m/px = 2πA·cos φ / (512 · 2^z) — HALF what a 256-px convention gives, and
 *  getting that wrong puts this a whole zoom out). At lat 38.1 the cell spacing is 0.0355 · 2^z:
 *
 *    z9  → 18.2 px   (one level coarser: every 2nd cell)
 *    z10 → 36.4 px   ← in [34, 68): the drawn set is the catalogue lattice
 *    z11 → 72.8 px   (one level finer: sub-cell nodes appear, 4× the arrows)
 *
 *  Confirmed against the render, not just derived: the advected and catalogue fields paint within
 *  2.5% of each other at z10 (0.02126 vs 0.02180) and the advected field paints 3.8× more at z11.
 *  Change the fixture's spacing or the base glyph length and this moves — which is why it is
 *  derived here instead of being a number someone found by trying zooms. */
const ZOOM = 10
/** One level coarser, for claim C. */
const ZOOM_OUT = 9
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
  let sumR = 0
  let sumG = 0
  let sumB = 0
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
        sumR += r
        sumG += g
        sumB += b
        // Carry the COLOUR, not just coverage: two fields can cover the same cells and still
        // disagree about which speed band is there, which is exactly the failure that looks
        // like a working animation.
        cells[c]! += (r + 2 * g + 4 * b) / 7
      }
    }
  }
  for (let c = 0; c < cells.length; c++) cells[c]! /= Math.max(1, counts[c]!)
  // Mean colour over PAINTED pixels only — the band-parity metric, and the reason it is over
  // painted pixels is that background would otherwise dominate it and wash out exactly the
  // difference being looked for. Drift-immune: an arrow that has moved is still standing in the
  // same field, so the distribution of bands the field paints does not depend on WHERE in its
  // leash each glyph happens to be.
  const n = Math.max(1, painted)
  return {
    ok: true as const,
    backend: w.__xgisMap?.ctx?.rhi?.backend,
    W,
    H,
    painted: painted / (W * H),
    cells: Array.from(cells),
    mean: [sumR / n, sumG / n, sumB / n] as [number, number, number],
  }
}

/** Mean absolute per-cell difference — the directional metric both claims are stated in. */
const diff = (a: number[], b: number[]): number => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!)
  return s / a.length
}

async function boot(page: import('@playwright/test').Page, zoom = ZOOM) {
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
    `/demo.html?id=s111_currents&forcegl2=1&e2e=1&adaptive=0#${zoom}/${CENTRE_LAT}/${CENTRE_LON}`,
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
  test('at the level-0 rung the advected field IS the catalogue field — and then it moves', async ({
    page,
  }) => {
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

    const moved = diff(adv0.cells, advN.cells)
    const inkRatio = adv0.painted / Math.max(staticA.painted, 1e-9)
    // Mean-colour distance in 0–255 units. The catalogue palette's own bands are tens of units
    // apart, so a band-assignment error is not a small number here.
    const dColor = Math.hypot(
      adv0.mean[0] - staticA.mean[0],
      adv0.mean[1] - staticA.mean[1],
      adv0.mean[2] - staticA.mean[2],
    )
    console.log(
      `[s111-advected] floor=${floor.toFixed(4)} moved(adv0↔advN)=${moved.toFixed(4)} ` +
        `painted static=${staticA.painted.toFixed(5)} adv=${adv0.painted.toFixed(5)} ` +
        `ink=${inkRatio.toFixed(3)} dColor=${dColor.toFixed(2)} ` +
        `mean static=[${staticA.mean.map((v) => v.toFixed(1))}] ` +
        `adv=[${adv0.mean.map((v) => v.toFixed(1))}]`,
    )

    // CLAIM B — the arrows moved, by much more than the same-code noise floor. Stated first
    // because it is the precondition for A meaning anything: if nothing moved, A would pass by
    // drawing a frozen field.
    expect(moved, 'the advected field changed between frames').toBeGreaterThan(
      Math.max(floor * 4, 0.5),
    )

    // CLAIM A, first half — the rung draws the CELL set. Same number of arrows at the same size
    // is the same ink, and the two ways to break it are both caught: a field thinned one level
    // too far paints a quarter as much, one drawing the whole 8× lattice paints 64× as much.
    // Measured 0.976; the band is deliberately far tighter than either failure.
    expect(
      inkRatio,
      'the rung is not drawing the catalogue set — a level out, or the whole lattice',
    ).toBeGreaterThan(0.75)
    expect(
      inkRatio,
      'the rung is not drawing the catalogue set — a level out, or the whole lattice',
    ).toBeLessThan(1.35)

    // CLAIM A, second half — and it is the SAME CATALOGUE. Two independent implementations of
    // one rule: the static path bakes `bandedRampColor(speed)` per cell on the CPU, the advected
    // VS indexes the uploaded table with a speed it read from a texture and normalized by the
    // field's peak. A drift in the table, the peak or the scale rule moves this.
    expect(
      dColor,
      'the advected field paints different BANDS than the catalogue rule — the table, the peak ' +
        'normalization or the scale rule has drifted',
    ).toBeLessThan(12)
  })

  test('the rung is a RUNG — one zoom out the same field draws fewer arrows', async ({ page }) => {
    test.setTimeout(180_000)
    // Without this, claim A above is a measurement at one camera with nothing saying the ladder
    // moves at all — and the unconditional contract #1450 retired could creep back in as "parity
    // held wherever we looked". Here the catalogue field is the invariant control: it has no
    // density rule, so its ink changes with the zoom only as the footprint does, while the
    // advected field must ALSO drop a decimation level.
    await boot(page, ZOOM_OUT)

    await run(page, style('| arrow'))
    await page.waitForTimeout(1500)
    const cells = await page.evaluate(readGrid)
    expect(cells.ok, 'WebGL2 context present').toBe(true)
    if (!cells.ok) return
    expect(cells.backend, 'running on the WebGL2 backend, not a silent fallback').toBe('webgl2')

    await run(page, style('| flow'))
    await page.waitForTimeout(400)
    const adv = await page.evaluate(readGrid)
    if (!adv.ok) return

    const ratio = adv.painted / Math.max(cells.painted, 1e-9)
    console.log(
      `[s111-advected] z${ZOOM_OUT} static painted=${cells.painted.toFixed(5)} ` +
        `adv0 painted=${adv.painted.toFixed(5)} ratio=${ratio.toFixed(3)}`,
    )

    expect(cells.painted, 'the catalogue field drew').toBeGreaterThan(0.005)
    expect(adv.painted, 'the advected field drew').toBeGreaterThan(0)
    // A whole decimation level is a 4× cut in arrows (2× per axis), so the bound sits well below
    // the rung's own band above and well above the noise: the two claims cannot both be satisfied
    // by one density.
    expect(
      ratio,
      'one zoom out the advected field did NOT thin — the ladder is not moving',
    ).toBeLessThan(0.6)
  })
})
