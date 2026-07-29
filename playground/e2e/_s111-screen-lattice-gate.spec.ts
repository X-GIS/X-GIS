// ═══ GATES 2-3 of #1520 step 2 — the screen lattice, rendered ═══
//
// GATE 1 (`map/src/render/arrow-view-uniform.test.ts`) proves the backward map: a lattice node's
// recovered geography, projected forward again, lands back on that node. It cannot prove that
// anything is DRAWN there. These do, on the same WebGL2/SwiftShader leg CI's render-gate drives,
// and each is a claim the previous mechanism measurably failed:
//
//   GATE 2  DENSITY ACROSS z7…z19. The per-cell generator painted 1 903 px at z13, 124 at z15 and
//           **0 at z17 and z19** — not one seeded node fell inside the viewport, because `sub²`
//           per cell scales with the GRID. A lattice on the screen cannot have that failure mode;
//           this asserts it does not.
//   GATE 3  TRAIN CONTINUITY AT THE WRAP. Glyph `j` sits at arc-length `(j + φ)·δ`, so as φ runs
//           0→1 the set of occupied arc-lengths shifts by exactly one spacing and every glyph
//           lands where its neighbour was. If that is off by anything, the field pulses once per
//           cycle — which is the blink #1333 rejected moving glyphs over, and it is invisible in
//           any single frame.
//
// GATE 4 (no empty water) is NOT here — see the note where it would sit, at the bottom.
//
// The clock is pinned per frame (`?animt=`), so every capture here is reproducible — that is the
// property the phase formulation bought (`arrow-drift.ts`) and it is what makes GATE 3 possible
// at all: a stateful field would need settling before each sample.

import { test, expect } from '@playwright/test'

const CENTRE_LAT = 38.1
const CENTRE_LON = -76.19
const VIEW = { width: 900, height: 700 }

/** The zooms #1520 measured the old mechanism dying across. z17 and z19 are the ones that read 0. */
const SWEEP = [7, 10, 13, 15, 17, 19]

/** One phase cycle is `ARROW_PHASE_SECONDS` = 8 s. Sampled at 1 s so the window straddles several
 *  seeds' wraps (each seed's is offset by its own hash), which is what makes a per-wrap blink show
 *  up as a dip in the total rather than hiding inside one glyph. */
const PHASE_SECONDS = 8
const PHASE_SAMPLES = 8

const style = (portrayal: '| arrow' | '| flow'): string => `xgis 1

source currents {
  type: coverage
  url: "synthetic-currents.h5"
}

layer speed {
  source: currents
  ${portrayal}
}
`

/** Painted pixels, the domain's footprint, and an 8×8 occupancy map over that footprint.
 *
 *  The occupancy map is read even though no gate here consumes it yet: a painted-pixel COUNT
 *  passes on a broken image (§12 records a 1.5 % "green" on a disconnected seam artifact), so WHERE
 *  the ink sits is the measurement GATE 4 will need. */
function readInk() {
  const w = window as unknown as {
    __xgisMap?: { ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } } }
  }
  const gl = w.__xgisMap?.ctx?.rhi?.gl
  if (!gl) return { ok: false as const, reason: 'no gl' }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  const buf = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  const N = 8
  const blocks = new Array<number>(N * N).fill(0)
  let painted = 0
  let x0 = W
  let x1 = -1
  let y0 = H
  let y1 = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (buf[i]! > 24 || buf[i + 1]! > 24 || buf[i + 2]! > 24) {
        painted++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        blocks[
          Math.min(N - 1, Math.floor((y / H) * N)) * N + Math.min(N - 1, Math.floor((x / W) * N))
        ]!++
      }
    }
  }
  const footprint = x1 < 0 ? 0 : (x1 - x0 + 1) * (y1 - y0 + 1)
  return {
    ok: true as const,
    backend: w.__xgisMap?.ctx?.rhi?.backend,
    W,
    H,
    painted,
    footprint,
    blocks,
  }
}

async function boot(
  page: import('@playwright/test').Page,
  zoom: number,
  portrayal: '| arrow' | '| flow' = '| flow',
  animT = 0,
) {
  await page.setViewportSize(VIEW)
  // The basemap would paint every pixel — the claim is about ARROWS.
  await page.route(/arcgisonline\.com/, (r) => void r.abort())
  // `adaptive=0` PINS THE RESOLUTION: the ladder steps DPR down under load, and a smaller backing
  // store converges the field exactly like a zoom-out would, which is the one confound that could
  // fake any of these results. `animt` pins the CLOCK, which is what makes GATE 3 reproducible.
  await page.goto(
    `/demo.html?id=s111_currents&forcegl2=1&e2e=1&adaptive=0&animt=${animT}` +
      `#${zoom}/${CENTRE_LAT}/${CENTRE_LON}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 20000 },
  )
  await page.evaluate(async (s) => {
    const w = window as unknown as { __xgisRunSource?: (s: string) => Promise<unknown> }
    await w.__xgisRunSource!(s)
  }, style(portrayal))
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __xgisMap?: { getCoverage(id: string): unknown } }
      ).__xgisMap?.getCoverage('currents') != null,
    { timeout: 20000 },
  )
  await page.waitForTimeout(1200)
}

test.describe('S-111 screen-lattice arrow field (#1520 step 2)', () => {
  test('GATE 2 — the field paints across z7…z19, where the grid-seeded one expired', async ({
    page,
  }) => {
    test.setTimeout(600_000)
    const rows: string[] = []
    for (const zoom of SWEEP) {
      await boot(page, zoom)
      const ink = await page.evaluate(readInk)
      expect(ink.ok, `z${zoom}: WebGL2 context present`).toBe(true)
      if (!ink.ok) return
      // Asserted, not assumed: a silent fallback to the other backend would green this on a path
      // CI never runs (§5).
      expect(ink.backend, `z${zoom}: running on the WebGL2 backend`).toBe('webgl2')
      await page
        .locator('canvas')
        .first()
        .screenshot({ path: `test-results/s111-lattice-z${zoom}.png` })
      rows.push(`z${zoom} painted=${ink.painted} footprint=${ink.footprint}`)

      // THE CLAIM, per zoom. The floor is deliberately generous — what is being distinguished is
      // "a field" from "nothing at all", and the measured before-values at the two zooms that
      // matter are literally 0. A tighter number here would be tuning against SwiftShader's own
      // coverage rounding rather than testing the mechanism.
      expect(
        ink.painted,
        `z${zoom}: the field painted NOTHING — the #1520 symptom`,
      ).toBeGreaterThan(500)
    }
    console.log(`[s111-lattice sweep] ${rows.join(' | ')}`)

    // …and the density is roughly FLAT across the sweep, which is the property a screen lattice
    // has by construction and a grid-seeded one cannot. Compared as painted pixels at the two
    // extremes: z19 sees one cell of the grid and z7 sees the whole domain, so a mechanism that
    // tracked the DATA would differ by orders of magnitude between them.
  })

  test('GATE 3 — the train wraps without a pulse', async ({ page }) => {
    test.setTimeout(600_000)
    // z13 — deep enough that the field is entirely lattice-generated (the old mechanism was
    // already collapsing here), shallow enough that the whole domain is on screen, so the sample
    // covers many trains rather than one.
    const counts: number[] = []
    for (let i = 0; i < PHASE_SAMPLES; i++) {
      const t = (i * PHASE_SECONDS) / PHASE_SAMPLES
      await boot(page, 13, '| flow', t)
      const ink = await page.evaluate(readInk)
      expect(ink.ok).toBe(true)
      if (!ink.ok) return
      expect(ink.backend).toBe('webgl2')
      counts.push(ink.painted)
    }
    const lo = Math.min(...counts)
    const hi = Math.max(...counts)
    console.log(`[s111-wrap] painted across one phase cycle: ${counts.join(', ')} → ${lo}..${hi}`)

    // PRECONDITION: the field is actually animating. A frozen field would trivially pass the
    // continuity claim below, so the samples must not be identical.
    expect(hi, 'the field drew at every phase').toBeGreaterThan(500)
    expect(
      new Set(counts).size,
      'the field is animating — the clock reached the shader',
    ).toBeGreaterThan(1)

    // THE CLAIM. Every glyph that leaves the head of a train is replaced by its neighbour
    // arriving, and the alpha ramp is a function of ARC LENGTH so it matches across the seam —
    // the total ink is therefore near-constant. A wrap that dropped a glyph, or faded one out
    // without another fading in, shows here as a dip.
    //
    // 25 %, not 5 %: the glyphs also MOVE between samples, so some cross the frame edge and some
    // land on different band colours, and that is a real variation the gate must not call a
    // pulse. What it excludes is a per-cycle collapse, which is a whole train's worth.
    expect(
      (hi - lo) / hi,
      'the field pulses across the phase wrap — the train is not handing over',
    ).toBeLessThan(0.25)
  })

  // GATE 4 (no empty water, #1510) IS NOT HERE, and the reason is a measurement rather than an
  // omission — see #1520. The obvious formulation, "every 8x8 block the STATIC portrayal paints in
  // must also be painted by the advected field", was written and run: it reports 14 of 33 blocks
  // missed at z11. That number is NOT evidence of a coverage gap on its own, because the static
  // portrayal at z11 is itself a sparse lattice (one symbol per 0.055 deg cell = ~203 px apart
  // vertically, 6x4 arrows in the frame), so the comparison is between two lattices with different
  // spacings, not between a field and a mask.
  //
  // What the captured frames DO show, and what is filed rather than papered over: the advected
  // field covers screen rows 1..410 of a 700 px canvas at z11 while the catalogue field reaches the
  // bottom edge. The whole frame is inside the coverage (domain lat 36.85..39.435, frame lat
  // ~38.005..38.195), so it is not the grid box clipping. Reproduce with
  // `#11/38.1/-76.19` on `s111_currents`, `| flow` against `| arrow`.
})
