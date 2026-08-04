// ═══ The DEAD-BOUNDARY HALO gate — empty water near nodata stays bounded (#1558) ═══
//
// Reported from real S-111 data: the advected arrow field left large empty patches over water that
// is clearly flowing, and — the load-bearing observation — ZOOMING IN FILLED THEM. GATE 4 cannot
// see that defect (8×8 blocks, one pixel greens a 60×88 px block), so this spec was first written
// as a pure DIAGNOSTIC and its measurements decided the fix; it is now the regression gate over
// the mechanism those measurements convicted.
//
// WHAT THE DIAGNOSTIC ESTABLISHED (all numbers deterministic across re-runs — pinned clock,
// SwiftShader):
//   · open water loses NOTHING to zoom: speed-matched window ink close/wide = 1.01;
//   · the loss lives within ~½δ of DEAD cells: ink there was 0.238 against 0.308 in open water
//     (ratio 0.77) — trains that walked into a nodata/calm cell re-symbolized at the walk's end,
//     sampled (0,0), and were erased by the size product;
//   · H3 (train anisotropy) was refuted outright: across-flow and along-flow empty runs are
//     symmetric (med 7 vs 9 px).
// On real data, scattered in-water nodata cells weld those SCREEN-fixed halos into the reported
// voids at wide zooms; zooming in shrinks each halo to its own cell, which is the "zooming in
// fills them" observation exactly.
//
// THE FIX (`arrow-advected.ts`, the last-live-footing tracker) stops a train at the dead boundary
// instead of erasing it; measured bin0 recovery 0.238 → 0.263 (ratio 0.85). The REMAINING deficit
// is geometric and standard-correct: within ½δ of a dead region, no ink arrives from the dead
// side, because the standard forbids symbols there — the same vignette any field has at its edge.
//
// THE ASSERTION: bin0/open-water ink ratio ≥ 0.8 at the wide zoom. Fail-before is the measured
// pre-fix build: 0.77, red under this bound; the fixed build measures 0.85. The harness is
// deterministic (identical digits across reruns), which is what makes the thin margin honest
// rather than flaky — and a future change that re-introduces walk mortality lands back at 0.77.
//
// THE THREE CANDIDATE MECHANISMS, and how the measurements separate them:
//
//   H1  WALK MORTALITY. A train is walked up to 4δ px in SCREEN arc length. At a wide zoom one
//       grid cell is a few px, so a walk crosses tens of cells and dies wherever it lands on a
//       nodata/calm cell — re-symbolization samples the END position (`arrow-advected.ts`), a
//       dead cell packs (0,0) (`flow-field-pack.ts:52`), and `step(1e-6, speed)` erases the
//       glyph. Zoom in and the same walk stays inside one cell, so the field survives — the only
//       hypothesis that matches "zooming in fills the gaps".
//       → SIGNATURE: ink-per-water-pixel COLLAPSES at the wide zoom (the lattice is
//         screen-uniform, so with no mortality it would be zoom-invariant), and the missing ink
//         concentrates within ~4δ of dead regions (the halo profile).
//
//   H2  GENUINE NODATA. The data simply has no values there.
//       → SIGNATURE: emptiness tracks the dead-region FOOTPRINT at every zoom — the halo width
//         in δ units GROWS as you zoom in (a fixed ground area is more δ at a closer zoom),
//         where H1's halo is ~4δ at the wide zoom and collapses at the close one.
//
//   H3  TRAIN ANISOTROPY. G=4 glyphs per seed string along ONE streamline: δ apart along the
//       flow, S=2δ across it — chains with lanes between them.
//       → SIGNATURE: zoom-INVARIANT (everything is screen-proportional), visible as
//         across-flow empty runs ~2× the along-flow ones in coherent flow.
//
// The fixture is `synthetic-currents.h5` — closed-form (playground/scripts/gen-demo-coverage.py),
// so its land/nodata mask is REPLICATED here analytically and the water mask is exact, not
// estimated from pixels. `map.unproject` (CSS px → lon/lat) supplies the per-pixel geography.

import { test, expect } from '@playwright/test'

const CENTRE_LAT = 38.1
const CENTRE_LON = -76.19
const VIEW = { width: 600, height: 700 }
/** Inter-glyph spacing δ in device px — `S111_ARROW_BASE_PX`, dpr 1 headless. */
const DELTA_PX = 34

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

/** One zoom arm's measurements, all computed in-page in a single evaluate. */
interface Arm {
  ok: true
  backend: string | undefined
  W: number
  H: number
  /** Full-res water pixels inside the domain, per the analytic mask. */
  waterPx: number
  /** Ink pixels standing on water. */
  inkPx: number
  /** Ink fraction per halo bin: distance-to-nearest-dead-region in HALF-δ units, bins 0…11
   *  ([0,0.5δ), [0.5δ,1δ), … [5.5δ,6δ)), plus [12] = everything farther. -1 = empty bin. */
  halo: number[]
  /** Median / p90 of EMPTY run lengths (px) inside the all-water mid-channel window,
   *  horizontal (across the northward flow) and vertical (along it). */
  runs: { hMed: number; hP90: number; vMed: number; vP90: number; window: number }
  /** Ink fraction INSIDE the mid-channel window — the same water on both arms, so the
   *  speed→glyph-size confound (a close zoom looks only at the fast channel; a wide one
   *  averages slow coastal water in) cancels and the ratio isolates instance loss. */
  windowInkFrac: number
}

const measure = (deltaPx: number): Arm | { ok: false; reason: string } => {
  const w = window as unknown as {
    __xgisMap?: {
      ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } }
      unproject?: (s: readonly [number, number]) => [number, number] | null
    }
  }
  const gl = w.__xgisMap?.ctx?.rhi?.gl
  const unproject = w.__xgisMap?.unproject?.bind(w.__xgisMap)
  if (!gl || !unproject) return { ok: false, reason: 'no gl/unproject' }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  const buf = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  // readPixels is bottom-up; index ink with a flipped y so everything below is screen-space.
  const inkAt = (x: number, y: number): boolean => {
    const i = ((H - 1 - y) * W + x) * 4
    return buf[i]! > 24 || buf[i + 1]! > 24 || buf[i + 2]! > 24
  }

  // ── the analytic water mask, at Q-px resolution ────────────────────────────────────────────
  // The fixture's own formulas (gen-demo-coverage.py `currents()`), verbatim. `gy` is the
  // NORTHWARD fraction; the write stores south-up with gridOriginLatitude at the south edge, so
  // gy = (lat − origin) / span directly.
  const ORIGIN_LON = -76.58
  const ORIGIN_LAT = 36.85
  const SPAN_LON = 31 * 0.025
  const SPAN_LAT = 47 * 0.055
  const waterAt = (gx: number, gy: number): boolean => {
    if (gx < 0 || gx > 1 || gy < 0 || gy > 1) return false
    const westLand = 0.1 + 0.06 * Math.sin(gy * 5.1)
    const eastLand = 0.1 + 0.06 * Math.cos(gy * 3.7)
    if (gx < westLand || gx > 1 - eastLand) return false
    if (Math.hypot(gx - 0.62, gy - 0.55) < 0.045) return false
    return true
  }
  const Q = 4
  const QW = Math.ceil(W / Q)
  const QH = Math.ceil(H / Q)
  // Mercator: lon is linear in x and lat depends only on y, so two unprojects per row are exact.
  const water = new Uint8Array(QW * QH)
  const gxRow = new Float64Array(QW)
  for (let qy = 0; qy < QH; qy++) {
    const y = Math.min(H - 1, qy * Q + Q / 2)
    const a = unproject([0, y])
    const b = unproject([W - 1, y])
    if (!a || !b) continue
    const gy = (a[1] - ORIGIN_LAT) / SPAN_LAT
    for (let qx = 0; qx < QW; qx++) {
      const x = Math.min(W - 1, qx * Q + Q / 2)
      const lon = a[0] + ((b[0] - a[0]) * x) / (W - 1)
      gxRow[qx] = (lon - ORIGIN_LON) / SPAN_LON
      water[qy * QW + qx] = waterAt(gxRow[qx]!, gy) ? 1 : 0
    }
  }

  // ── distance to the nearest DEAD region (chamfer, two passes, quantized) ───────────────────
  const INF = 1e9
  const dist = new Float32Array(QW * QH).fill(INF)
  for (let i = 0; i < QW * QH; i++) if (!water[i]) dist[i] = 0
  const relax = (i: number, j: number, cost: number): void => {
    if (dist[j]! + cost < dist[i]!) dist[i] = dist[j]! + cost
  }
  for (let y = 0; y < QH; y++)
    for (let x = 0; x < QW; x++) {
      const i = y * QW + x
      if (x > 0) relax(i, i - 1, 1)
      if (y > 0) relax(i, i - QW, 1)
      if (x > 0 && y > 0) relax(i, i - QW - 1, 1.414)
      if (x < QW - 1 && y > 0) relax(i, i - QW + 1, 1.414)
    }
  for (let y = QH - 1; y >= 0; y--)
    for (let x = QW - 1; x >= 0; x--) {
      const i = y * QW + x
      if (x < QW - 1) relax(i, i + 1, 1)
      if (y < QH - 1) relax(i, i + QW, 1)
      if (x < QW - 1 && y < QH - 1) relax(i, i + QW + 1, 1.414)
      if (x > 0 && y < QH - 1) relax(i, i + QW - 1, 1.414)
    }

  // ── ink per water px, and the halo profile ─────────────────────────────────────────────────
  const BINS = 12
  const binInk = new Array<number>(BINS + 1).fill(0)
  const binAll = new Array<number>(BINS + 1).fill(0)
  let waterPx = 0
  let inkPx = 0
  for (let y = 0; y < H; y++) {
    const qy = Math.min(QH - 1, Math.floor(y / Q))
    for (let x = 0; x < W; x++) {
      const qi = qy * QW + Math.min(QW - 1, Math.floor(x / Q))
      if (!water[qi]) continue
      waterPx++
      const ink = inkAt(x, y)
      if (ink) inkPx++
      const dPx = dist[qi]! * Q
      const bin = Math.min(BINS, Math.floor(dPx / (deltaPx / 2)))
      binAll[bin]!++
      if (ink) binInk[bin]!++
    }
  }
  const halo = binAll.map((n, i) => (n === 0 ? -1 : binInk[i]! / n))

  // ── anisotropy: empty-run lengths in an all-water mid-channel window ───────────────────────
  // gx ∈ [0.38, 0.55], gy ∈ [0.40, 0.52] is open channel VISIBLE ON BOTH ARMS: the camera sits
  // at gy ≈ 0.48, and at the close zoom only gy ≈ [0.46, 0.51] is on screen at all — a window
  // south of that measured nothing (the first cut did exactly that). Clear of the island
  // (gx 0.575…0.665, gy 0.505…0.595) and of both coasts. Flow there is ~northward, so
  // HORIZONTAL runs are across-flow and VERTICAL runs along it.
  const inWindow = (qx: number, qy: number): boolean => {
    const y = Math.min(H - 1, qy * Q + Q / 2)
    const a = unproject([0, y])
    const b = unproject([W - 1, y])
    if (!a || !b) return false
    const gy = (a[1] - ORIGIN_LAT) / SPAN_LAT
    const x = Math.min(W - 1, qx * Q + Q / 2)
    const gx = (a[0] + ((b[0] - a[0]) * x) / (W - 1) - ORIGIN_LON) / SPAN_LON
    return gx >= 0.38 && gx <= 0.55 && gy >= 0.4 && gy <= 0.52
  }
  // Window bounds in full-res px (scan the quant grid once).
  let wx0 = W
  let wx1 = -1
  let wy0 = H
  let wy1 = -1
  for (let qy = 0; qy < QH; qy++)
    for (let qx = 0; qx < QW; qx++)
      if (inWindow(qx, qy)) {
        wx0 = Math.min(wx0, qx * Q)
        wx1 = Math.max(wx1, qx * Q + Q - 1)
        wy0 = Math.min(wy0, qy * Q)
        wy1 = Math.max(wy1, qy * Q + Q - 1)
      }
  const hRuns: number[] = []
  const vRuns: number[] = []
  let winInk = 0
  let winAll = 0
  if (wx1 > wx0 && wy1 > wy0) {
    for (let y = wy0; y <= wy1; y++)
      for (let x = wx0; x <= wx1; x++) {
        winAll++
        if (inkAt(x, y)) winInk++
      }
    for (let y = wy0; y <= wy1; y += 2) {
      let run = 0
      for (let x = wx0; x <= wx1; x++) {
        if (inkAt(x, y)) {
          if (run > 0) hRuns.push(run)
          run = 0
        } else run++
      }
    }
    for (let x = wx0; x <= wx1; x += 2) {
      let run = 0
      for (let y = wy0; y <= wy1; y++) {
        if (inkAt(x, y)) {
          if (run > 0) vRuns.push(run)
          run = 0
        } else run++
      }
    }
  }
  const q = (a: number[], p: number): number => {
    if (a.length === 0) return -1
    const s = [...a].sort((m, n) => m - n)
    return s[Math.min(s.length - 1, Math.floor(p * s.length))]!
  }
  return {
    ok: true,
    backend: w.__xgisMap?.ctx?.rhi?.backend,
    W,
    H,
    waterPx,
    inkPx,
    halo,
    runs: {
      hMed: q(hRuns, 0.5),
      hP90: q(hRuns, 0.9),
      vMed: q(vRuns, 0.5),
      vP90: q(vRuns, 0.9),
      window: wx1 < wx0 ? 0 : (wx1 - wx0 + 1) * (wy1 - wy0 + 1),
    },
    windowInkFrac: winAll === 0 ? -1 : winInk / winAll,
  }
}

async function boot(page: import('@playwright/test').Page, zoom: number): Promise<void> {
  await page.setViewportSize(VIEW)
  await page.route(/arcgisonline\.com/, (r) => void r.abort())
  await page.goto(
    `/demo.html?id=s111_currents&forcegl2=1&e2e=1&adaptive=0&animt=0#${zoom}/${CENTRE_LAT}/${CENTRE_LON}`,
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
  await page.waitForTimeout(1200)
}

test.describe('S-111 empty-water diagnosis (#1558) — measurement, not a gate', () => {
  test('ink-per-water, dead-region halo, and run anisotropy across the zoom split', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    // WIDE: one grid cell ≈ 9 px ≪ δ=34 — a 4δ walk crosses ~15 cells. CLOSE: one cell ≈ 146 px
    // ≫ δ — the walk stays inside its seed's cell. H1 predicts the ink collapses on the first
    // arm and recovers on the second; H2 predicts footprint-proportional emptiness on both.
    const arms: Record<number, Arm> = {}
    for (const zoom of [9, 13]) {
      await boot(page, zoom)
      const m = await page.evaluate(measure, DELTA_PX)
      expect(m.ok, `zoom ${zoom}: page measured (${'reason' in m ? m.reason : ''})`).toBe(true)
      if (!m.ok) return
      expect(m.backend, 'WebGL2, not a silent fallback').toBe('webgl2')
      expect(m.waterPx, 'the analytic water mask found the domain').toBeGreaterThan(10_000)
      expect(m.inkPx, 'the field painted at all').toBeGreaterThan(0)
      arms[zoom] = m
      const f = (m.inkPx / m.waterPx).toFixed(4)
      console.log(
        `[s111-diagnosis] z${zoom} ${m.W}x${m.H} water=${m.waterPx} ink=${m.inkPx} inkFrac=${f}`,
      )
      console.log(
        `[s111-diagnosis] z${zoom} halo(δ/2 bins, ink fraction): ` +
          m.halo.map((v) => (v < 0 ? '·' : v.toFixed(3))).join(' '),
      )
      console.log(`[s111-diagnosis] z${zoom} windowInkFrac=${m.windowInkFrac.toFixed(4)}`)
      console.log(
        `[s111-diagnosis] z${zoom} runs px (window ${m.runs.window}): ` +
          `across-flow med=${m.runs.hMed} p90=${m.runs.hP90} | ` +
          `along-flow med=${m.runs.vMed} p90=${m.runs.vP90}`,
      )
      await page.screenshot({
        path: `test-results/s111-diagnosis-z${zoom}.png`,
        fullPage: false,
      })
    }
    // The one comparative number the hypotheses disagree on, logged as its own line.
    const wide = arms[9]!.inkPx / arms[9]!.waterPx
    const close = arms[13]!.inkPx / arms[13]!.waterPx
    console.log(
      `[s111-diagnosis] ink-per-water close/wide = ${(close / wide).toFixed(2)} ` +
        `(≈1 ⇒ no mortality; ≫1 ⇒ instance loss at the wide zoom)`,
    )
    // The confound-free form: the SAME mid-channel water on both arms.
    console.log(
      `[s111-diagnosis] WINDOW ink close/wide = ` +
        `${(arms[13]!.windowInkFrac / arms[9]!.windowInkFrac).toFixed(2)} ` +
        `(speed-matched — this one isolates instance loss from glyph-size sampling)`,
    )

    // ── THE GATE ──────────────────────────────────────────────────────────────────────────────
    // Open water is the wide arm's own control (the far bin), so the bound is a RATIO — immune to
    // density retunes, glyph-size changes, and interleave switches, all of which move numerator
    // and denominator together. What it is NOT immune to is exactly the convicted mechanism:
    // erase a boundary-stopped train again and bin0 collapses while open water does not.
    const z9 = arms[9]!
    const open = z9.halo[12]!
    const bin0 = z9.halo[0]!
    expect(open, 'the wide arm has an open-water reference bin').toBeGreaterThan(0)
    expect(bin0, 'the wide arm has a dead-boundary bin').toBeGreaterThan(0)
    const ratio = bin0 / open
    console.log(`[s111-diagnosis] GATE dead-boundary/open-water ink ratio = ${ratio.toFixed(3)}`)
    expect(
      ratio,
      'ink within ½δ of a dead region fell against open water — trains are being erased at ' +
        'the boundary again instead of stopping on it (#1558; pre-fix measured 0.77)',
    ).toBeGreaterThan(0.8)
    // …and the speed-matched open-water invariance that ACQUITTED the other hypotheses stays
    // pinned too: instance loss in open water would show here first.
    const winRatio = arms[13]!.windowInkFrac / arms[9]!.windowInkFrac
    expect(winRatio, 'open water loses instances with zoom (#1558 H1-open)').toBeLessThan(1.15)
    expect(winRatio, 'and gains none it should not').toBeGreaterThan(0.85)
  })
})
