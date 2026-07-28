// ═══ Two resident domains keep advecting a LEASHED field ═══
//
// WHAT THIS GATE DOES NOT DO, first, because it was written believing otherwise: it does **not**
// discriminate the mosaic texel collision of #1458. That was checked rather than assumed — the
// fix was disabled (every batch forced back to base 0, the pre-#1458 behaviour) and this gate
// still passed, with numbers identical to three decimal places:
//
//     fixed:  t0 L=0.4053 R=0.4005 | t3 L=0.3727 R=0.3840 | Δ L=0.0325 R=0.0166
//     broken: t0 L=0.4041 R=0.3999 | t3 L=0.3739 R=0.3834 | Δ L=0.0303 R=0.0165
//
// The reason is the FIXTURE, not the gate or the fix (the emitted WGSL really does read
// `inst + u32(band_data[73u])`, verified separately): `synthetic-currents-east.h5` is the west
// fixture translated east, so both domains have the same grid and the same valid-cell pattern —
// and therefore **identical origin arrays in grid-uv**. One region overwriting the other's
// texels writes the same numbers back. A fixture that discriminates needs a second domain with
// a DIFFERENT cell count, which is also what would exercise the overflow half of #1458.
//
// WHAT IT DOES ASSERT, and this is real: the field stays LEASHED while two domains are resident.
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

// Same framing as the residency gate: the west fixture and its eastern twin abut at this lon.
const CENTRE_LON = -75.78
const CENTRE_LAT = 38.17
const ZOOM = 7
const EAST_FIXTURE = '/data/synthetic-currents-east.h5'

/** Painted fraction of the left half, the right half, and the whole frame. */
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
  let left = 0
  let right = 0
  let leftTot = 0
  let rightTot = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const painted = buf[i]! > 24 || buf[i + 1]! > 24 || buf[i + 2]! > 24
      if (x < W / 2) {
        leftTot++
        if (painted) left++
      } else {
        rightTot++
        if (painted) right++
      }
    }
  }
  return {
    ok: true as const,
    backend: w.__xgisMap?.ctx?.rhi?.backend,
    W,
    H,
    left: left / leftTot,
    right: right / rightTot,
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

    // The EASTERN twin under its own region key — the second domain, and the one whose batch
    // used to take the first's texels.
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
      if (!res.ok) throw new Error(`east fixture ${file}: HTTP ${res.status}`)
      await w.__xgisMap!.setCoverageData('currents', await res.arrayBuffer(), {
        region: 'east',
        url: file,
      })
      w.__xgisMap!.invalidate?.()
    }, EAST_FIXTURE)
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
      `[s111-mosaic-advected] t0 L=${t0.left.toFixed(4)} R=${t0.right.toFixed(4)} | ` +
        `t3 L=${t1.left.toFixed(4)} R=${t1.right.toFixed(4)} | ` +
        `Δ L=${dLeft.toFixed(4)} R=${dRight.toFixed(4)} (${t1.W}x${t1.H})`,
    )

    // PRECONDITIONS, asserted rather than assumed: both domains are actually drawing. Without
    // these, a page that rendered nothing would satisfy the stability claim perfectly.
    expect(t0.left, 'west domain painted at t0').toBeGreaterThan(0.02)
    expect(t0.right, 'east domain painted at t0').toBeGreaterThan(0.02)
    expect(t1.left, 'west domain still painted at t3').toBeGreaterThan(0.02)
    expect(t1.right, 'east domain still painted at t3').toBeGreaterThan(0.02)

    // THE CLAIM. A leashed field's coverage barely moves; an unbounded drift sprays it across
    // the frame and off it, which shows up here as a large swing in either direction. The bound
    // is generous on purpose — it is not a tuned threshold, it is "the same field, still"
    // versus "a different field entirely". See the header for what this does NOT discriminate.
    expect(dLeft, 'west: coverage steady across the drift').toBeLessThan(0.05)
    expect(dRight, 'east: coverage steady across the drift').toBeLessThan(0.05)
  })
})
