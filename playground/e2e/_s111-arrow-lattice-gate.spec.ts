// ═══ The drifting arrows must stay a LATTICE, not become a scatter (#1520) ═══
//
// Reported from S-111 Live: "watching the animation, a pattern is visible… zoomed in, the arrows
// are clumped." That is not a portrayal choice going wrong — it is a statistical property of the
// drift, and it has a name.
//
// THE CAUSE. `ARROW_DRIFT_UV` is a fraction of the GRID's span; the distance to the next DRAWN
// arrow is a screen quantity the view-driven density picks per frame. Nothing tied the two, and
// they came apart the moment the field got denser than one arrow per cell: at one arrow per cell
// the leash was 1.55 slots, and holding the drawn spacing at a glyph length took it to 3.3. Points
// of a uniform lattice that each wander independently by more than one slot are a Poisson process
// — and a Poisson process is exactly what "clumped, with gaps" looks like. `arrow-drift.ts`
// tabulates the gap coefficient of variation over that ratio.
//
// THE FIX is `ARROW_SMEAR_SLOTS`: cap the on-screen excursion at one drawn slot. An arrow then
// travels as far as its neighbour's position and hands over, which reads as continuous flow while
// the lattice survives.
//
// WHAT THIS ASSERTS: how far the ink actually MOVES between two clocks half a phase apart, as a
// fraction of the ink itself. That is the quantity `ARROW_SMEAR_SLOTS` bounds, measured directly
// rather than through a proxy — and the bound is one drawn slot, so an arrow crossing several is
// exactly what the number reports.
//
// The clock is PINNED (`__xgisAnimT`), which is what makes it reproducible at all: the arrow
// position is a pure function of `(origin, phase)` since #1520, so a pinned clock gives a stable
// frame with no settling and no convergence pumping. The advected gate's own `moved` runs on the
// LIVE clock and ranges 12.8–18.4 on identical code — it cannot resolve this.
//
// THREE METRICS THAT DO NOT WORK are recorded so none of them gets proposed again (§12: an
// assertion carries information only if it distinguishes the states of the thing it tests):
//
//   • pixel COUNT — the capped and uncapped fields paint within 0.5 % of the same ink
//     (0.1095 vs 0.1104), so every count-based metric passes both.
//   • block-ink COEFFICIENT OF VARIATION, the obvious "is it clumped" statistic — 0.98 against
//     0.98. The coverage boundary dominates it.
//   • autocorrelation PEAK of the ink profile, computed below and logged as a diagnostic but NOT
//     asserted. Offline on cropped screenshots it separated 0.59 from 0.37; in-page over the whole
//     drawing buffer it separated 0.93 from 0.70 and the cut arm PASSED a bound drawn between the
//     offline numbers. The peak is dominated by the footprint's own smoothness at short lags, not
//     by the lattice. Detrending it (peak minus the half-lag value) does separate — 0.76 vs 0.20
//     offline — and is where to start if a shape statistic is ever wanted here.
//
// FAIL-BEFORE, verified by cutting the mechanism rather than by reasoning about it: with
// `ARROW_SMEAR_SLOTS` raised so the cap never binds (`min(1, …)` saturates), this measures 1.837
// against the 0.670 the capped arm measures. Both bounds below sit between measured states.
import { test, expect } from '@playwright/test'

/** Zoom, centre and viewport all matter here — the metric is over the drawn field's own spacing.
 *  z11 is one level finer than the catalogue rung, so the sub-cell lattice is drawn and there is
 *  a finer periodicity to lose. */
const ZOOM = 11
const CENTRE_LAT = 38.1
const CENTRE_LON = -76.19

/** Two clocks half a phase cycle apart (`ARROW_PHASE_SECONDS` is 8), so every arrow is somewhere
 *  else in its life at the second one. Both are read: the claim is about the field at ANY phase,
 *  not about one lucky frame. */
const CLOCKS = [0, 4] as const

const style = `xgis 1

source currents {
  type: coverage
  url: "synthetic-currents.h5"
}

layer speed {
  source: currents
  | flow
}
`

/** Ink profiles down the screen's columns and across its rows, plus the raw ink mask packed as a
 *  bit-per-pixel-free Uint8Array so the caller can diff two frames. Read out of the drawing
 *  buffer, so the editor chrome beside the canvas is not in it. */
function readProfiles() {
  const w = window as unknown as {
    __xgisMap?: { ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } } }
  }
  const gl = w.__xgisMap?.ctx?.rhi?.gl
  if (!gl) return { ok: false as const }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  const buf = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  const cols = new Float64Array(W)
  const rows = new Float64Array(H)
  const mask = new Uint8Array(W * H)
  let painted = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (buf[i]! > 24 || buf[i + 1]! > 24 || buf[i + 2]! > 24) {
        mask[y * W + x] = 1
        cols[x]! += 1
        rows[y]! += 1
        painted++
      }
    }
  }
  return {
    ok: true as const,
    backend: w.__xgisMap?.ctx?.rhi?.backend,
    W,
    H,
    painted: painted / (W * H),
    cols: Array.from(cols, (v) => v / H),
    rows: Array.from(rows, (v) => v / W),
    mask: Array.from(mask),
  }
}

/** Strongest normalized autocorrelation of a profile over the lags an arrow lattice can sit at.
 *  LOGGED, NOT ASSERTED — see the header for why it does not separate the two states. */
const periodicity = (profile: readonly number[]): number => {
  const n = profile.length
  const mean = profile.reduce((a, b) => a + b, 0) / n
  const v = profile.map((x) => x - mean)
  let zero = 0
  for (const x of v) zero += x * x
  let best = 0
  for (let lag = 8; lag < Math.min(120, n); lag++) {
    let s = 0
    for (let i = 0; i + lag < n; i++) s += v[i]! * v[i + lag]!
    best = Math.max(best, s / Math.max(zero, 1e-9))
  }
  return best
}

/** Fraction of the painted pixels that are somewhere else in the other frame. */
const xorFraction = (a: number[], b: number[]): number => {
  let x = 0
  let ink = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) x++
    if (a[i] === 1) ink++
  }
  return x / Math.max(ink, 1)
}

test.describe('S-111 advected arrows — the lattice survives the drift (#1520)', () => {
  test('an arrow never travels more than the distance to the next drawn one', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 900, height: 700 })
    // No basemap: every painted pixel below has to be an arrow or the profiles are noise.
    await page.route(/arcgisonline\.com/, (r) => void r.abort())
    // `adaptive=0` pins the resolution — the ladder steps DPR down under the animated load, and a
    // resolution change moves every profile for a reason that is not the arrows.
    await page.goto(
      `/demo.html?id=s111_currents&forcegl2=1&e2e=1&adaptive=0#${ZOOM}/${CENTRE_LAT}/${CENTRE_LON}`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      { timeout: 20000 },
    )
    await page.evaluate(async (s) => {
      const w = window as unknown as { __xgisRunSource?: (s: string) => Promise<unknown> }
      await w.__xgisRunSource!(s)
    }, style)
    await page.waitForFunction(
      () =>
        (
          window as unknown as { __xgisMap?: { getCoverage(id: string): unknown } }
        ).__xgisMap?.getCoverage('currents') != null,
      { timeout: 20000 },
    )

    const frames: { cols: number[]; rows: number[]; mask: number[]; painted: number }[] = []
    for (const t of CLOCKS) {
      await page.evaluate((v) => {
        ;(globalThis as { __xgisAnimT?: number }).__xgisAnimT = v
      }, t)
      await page.waitForTimeout(1200)
      const f = await page.evaluate(readProfiles)
      expect(f.ok, 'WebGL2 context present').toBe(true)
      if (!f.ok) return
      expect(f.backend, 'running on the WebGL2 backend, not a silent fallback').toBe('webgl2')
      expect(f.painted, 'the advected field actually rasterises').toBeGreaterThan(0.02)
      frames.push({ cols: f.cols, rows: f.rows, mask: f.mask, painted: f.painted })
      console.log(`[s111-lattice] t=${t} ${f.W}x${f.H} painted=${f.painted.toFixed(4)}`)
    }

    const moved = xorFraction(frames[0]!.mask, frames[1]!.mask)
    const measured = frames.map((f) => ({
      col: periodicity(f.cols),
      row: periodicity(f.rows),
    }))
    console.log(
      `[s111-lattice] moved=${moved.toFixed(3)} ` +
        measured
          .map((m, i) => `t${CLOCKS[i]}: col=${m.col.toFixed(3)} row=${m.row.toFixed(3)}`)
          .join(' | '),
    )

    // THE LOWER BOUND is the precondition: a field frozen at its origins keeps a perfect lattice
    // and would satisfy the upper bound trivially. The pinned clock makes that failure MORE
    // reachable, not less — a phase that never reaches the shader looks exactly like a pinned one.
    expect(moved, 'the field did not move between the two pinned clocks').toBeGreaterThan(0.15)

    // THE UPPER BOUND is the claim. Both bounds sit between two MEASURED states, not at round
    // numbers: with `ARROW_SMEAR_SLOTS` raised until the cap never binds, the same two frames
    // measure 1.837 against the 0.670 this arm measures.
    expect(
      moved,
      'the drifted field moved by far more than the drawn spacing — the excursion is no longer ' +
        'capped against it, so the lattice goes to a Poisson scatter (clumped, with gaps)',
    ).toBeLessThan(1.15)
  })
})
