// ═══ Two resident domains keep advecting a LEASHED field ═══
//
// THIS GATE DOES NOT DISCRIMINATE #1458, and the two attempts that established that are worth
// more than the gate itself. Both were run by disabling the fix (every batch forced back to
// base 0) and checking whether this went red. Neither did:
//
//   1. With the committed east twin — Δ fixed 0.0325/0.0166 vs broken 0.0303/0.0165. The
//      FIXTURE could not disagree: `synthetic-currents-east.h5` is the 32×48 field translated,
//      so both domains carry identical grid-uv origins and one overwriting the other writes the
//      same numbers back.
//   2. With `synthetic-currents-south.h5` (23×29, 467 valid cells against 1187, a different
//      coast mask) — Δ fixed 0.0008/0.0018 vs broken 0.0012/0.0016. The domains now genuinely
//      disagree, so this time the fault was the METRIC.
//
// WHY COVERAGE IS THE WRONG METRIC, which is also a correction to how #1458 described itself.
// The VS reads `pos` AND `origin` from the SAME texel (arrow-retained.ts). A foreign texel is
// foreign for both, so `pos − origin` stays inside the leash either way — the arrows are NOT
// flung anywhere. Screen position is dominated by the CPU-packed per-instance lon/lat, with the
// drift a small addend on top. What the collision actually corrupts is that `pos` is also the
// coordinate the velocity textures are sampled at, so the arrows read the WRONG CELL's current:
// wrong band colour, wrong heading, wrong size, and two regions moving in lockstep. Positions
// stay broadly right, which is exactly why a painted-fraction gate is blind to it.
//
// A gate that CAN see it has to measure colour: frame 0 of the advected field is the static
// catalogue placement, so a per-region directional diff against a static-only render is near
// the noise floor when each region reads its own uv and large when it does not — the parity
// rung `_s111-advected-arrows-gate` already uses, applied per half. That is the work this
// leaves open.
//
// WHAT THIS GATE DOES ASSERT, and it is real and was missing: the field stays LEASHED while two
// domains are resident.
// The drift a VS draws is
//
//     (position − origin) / ARROW_DRIFT_UV  ×  screen basis
//
// with ARROW_DRIFT_UV = 0.05. Bounded by the leash, an arrow never travels more than one leash
// length from its cell, so the frame's coverage barely moves between frame 0 (which IS the
// static catalogue placement) and three seconds of advection. Anything that unbounds that
// numerator — a recycle rule that stops firing, a basis scaled by the wrong span, an origin
// texture read that returns zero — sprays the field across and off the domain, and shows up
// here as a large swing in either direction.
//
// It is a structural claim rather than a pixel count: the frame is compared against ITSELF
// later, so there is no absolute threshold to tune and no way for "more paint" to read as
// "correct".

import { test, expect } from '@playwright/test'

// Framed to hold BOTH domains: the 32×48 Chesapeake field (lat 36.85–39.49) above, the
// 23×29 southern one (lat 34.90–36.26) below, split by the horizontal midline rather than the
// vertical one the residency gate uses.
const CENTRE_LON = -76.2
const CENTRE_LAT = 37.2
const ZOOM = 6
const SOUTH_FIXTURE = '/data/synthetic-currents-south.h5'

/** Painted fraction of the NORTH and SOUTH halves — the two domains sit one above the other.
 *  `readPixels` origin is bottom-left, so y < H/2 is the southern (23×29) domain. */
function readHalves() {
  const w = window as unknown as {
    __xgisMap?: { ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } } }
  }
  const gl = w.__xgisMap?.ctx?.rhi?.gl
  if (!gl) return { ok: false as const, reason: 'no gl' }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  const buf = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  let south = 0
  let north = 0
  let southTot = 0
  let northTot = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const painted = buf[i]! > 24 || buf[i + 1]! > 24 || buf[i + 2]! > 24
      if (y < H / 2) {
        southTot++
        if (painted) south++
      } else {
        northTot++
        if (painted) north++
      }
    }
  }
  return {
    ok: true as const,
    backend: w.__xgisMap?.ctx?.rhi?.backend,
    W,
    H,
    left: south / southTot,
    right: north / northTot,
  }
}

test.describe('S-111 mosaic — two domains keep advecting a LEASHED field', () => {
  test('two resident domains keep their coverage steady across three seconds of drift', async ({
    page,
  }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 900, height: 700 })
    // The basemap would paint every pixel and make every fraction vacuous — the same trap the
    // residency gate documents. A REGEX: `**/arcgisonline.com/**` does not match the host.
    await page.route(/arcgisonline\.com/, (r) => void r.abort())
    // `adaptive=0`: the advected field animates every frame, which drives the quality ladder
    // from DPR 1 to 0.5 within seconds — every pixel then changes for a reason that has nothing
    // to do with arrows moving, and this gate's whole claim is about a frame versus itself.
    await page.goto(
      `/demo.html?id=s111_currents&forcegl2=1&e2e=1&adaptive=0#${ZOOM}/${CENTRE_LAT}/${CENTRE_LON}`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      { timeout: 20000 },
    )
    await page.waitForFunction(
      () =>
        (
          window as unknown as { __xgisMap?: { getCoverage(id: string): unknown } }
        ).__xgisMap?.getCoverage('currents') != null,
      { timeout: 20000 },
    )

    // The SOUTHERN domain under its own region key — a different grid, so its batch has a
    // different count and different origins from the one already resident.
    await page.evaluate(async (file) => {
      const w = window as unknown as {
        __xgisMap?: {
          setCoverageData(
            id: string,
            bytes: ArrayBuffer,
            opts?: { region?: string; url?: string },
          ): Promise<void>
          invalidate?: () => void
        }
      }
      const res = await fetch(file)
      if (!res.ok) throw new Error(`south fixture ${file}: HTTP ${res.status}`)
      await w.__xgisMap!.setCoverageData('currents', await res.arrayBuffer(), {
        region: 'south',
        url: file,
      })
      w.__xgisMap!.invalidate?.()
    }, SOUTH_FIXTURE)
    await page.waitForTimeout(1200)

    const t0 = await page.evaluate(readHalves)
    expect(t0.ok, 'WebGL2 context present').toBe(true)
    if (!t0.ok) return
    expect(t0.backend, 'running on the WebGL2 backend — a silent fallback cannot green this').toBe(
      'webgl2',
    )
    await page.screenshot({ path: 'test-results/s111-mosaic-t0.png' })

    await page.waitForTimeout(3000)
    const t1 = await page.evaluate(readHalves)
    expect(t1.ok).toBe(true)
    if (!t1.ok) return
    await page.screenshot({ path: 'test-results/s111-mosaic-t3.png' })

    const dLeft = Math.abs(t1.left - t0.left)
    const dRight = Math.abs(t1.right - t0.right)
    console.log(
      `[s111-mosaic-advected] t0 S=${t0.left.toFixed(4)} N=${t0.right.toFixed(4)} | ` +
        `t3 S=${t1.left.toFixed(4)} N=${t1.right.toFixed(4)} | ` +
        `Δ S=${dLeft.toFixed(4)} N=${dRight.toFixed(4)} (${t1.W}x${t1.H})`,
    )

    // PRECONDITIONS, asserted rather than assumed: both domains are actually drawing. Without
    // these, a page that rendered nothing would satisfy the stability claim perfectly.
    expect(t0.left, 'south domain painted at t0').toBeGreaterThan(0.02)
    expect(t0.right, 'north domain painted at t0').toBeGreaterThan(0.02)
    expect(t1.left, 'south domain still painted at t3').toBeGreaterThan(0.02)
    expect(t1.right, 'north domain still painted at t3').toBeGreaterThan(0.02)

    // THE CLAIM. A leashed field's coverage barely moves; an unbounded drift sprays it across
    // the frame and off it, which shows up here as a large swing in either direction. The bound
    // is generous on purpose — it is not a tuned threshold, it is "the same field, still"
    // versus "a different field entirely". See the header for what this does NOT discriminate.
    expect(dLeft, 'south: coverage steady across the drift').toBeLessThan(0.05)
    expect(dRight, 'north: coverage steady across the drift').toBeLessThan(0.05)
  })
})
