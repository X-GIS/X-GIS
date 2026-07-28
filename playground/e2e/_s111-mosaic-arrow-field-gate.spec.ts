// ═══ A mosaic domain's arrows must read ITS OWN current — rendered (#1458) ═══
//
// The last thing #1458 left open. #1459 gave each region its own texel RANGE in the shared
// arrow state; the VELOCITY PAIR was still a single pair for the whole map, taken from
// `CoverageRenderer.activeFlowField()` (the FIRST resident region) and handed to every advected
// batch. A sibling domain's arrows therefore took their band colour, heading and scale from
// another domain's water — from FRAME 0, not as accumulated drift.
//
// WHY THE OBVIOUS GATE CANNOT SEE IT, established on the broken code before this one was
// written: painted-fraction / coverage is structurally blind here. The arrows are not flung
// anywhere — screen position is dominated by the CPU-packed per-instance lon/lat, and the VS
// reads `pos` and `origin` from the same texel, so the leash holds either way. Only the
// SYMBOLOGY is wrong. So this gate measures COLOUR.
//
// THE DISCRIMINATOR IS THE FIXTURE, and it is the one already in the tree. Measured, not
// assumed:
//
//   synthetic-currents.h5       48×32, 1187 valid cells, speed 0.037 … 1.904 kn (mean 0.71)
//   synthetic-currents-east.h5  48×32, 1187 valid cells, speed 6.5 kn CONSTANT
//
// The east twin is a FLAT field far above the west's range. An east arrow reading its own field
// is one uniform top band at one uniform scale; the same arrow reading the WEST field is a
// mottle of low bands at small scales. That is a large, structural colour difference that no
// amount of drift produces. (#1458's own comment judged this twin unable to discriminate — true
// of the ORIGIN collision #1459 fixed, since the two domains carry identical grid-uv origins,
// and NOT true of the field collision, which is about the values sampled AT those origins.)
//
// THE MEASURE IS A RATIO, so there is no absolute threshold to tune. Each half of the advected
// mosaic is compared against the SAME half of the STATIC `| arrow` mosaic — the CPU-side
// catalogue portrayal, which reads each region's own handle by construction. The WEST half is
// the CONTROL: it is the first region armed, so it binds its own field in the broken world too
// and its parity number is the noise floor of the comparison itself. The EAST half is the
// treatment. Fixed, the two halves agree; broken, only the east one blows up.
//
// On WebGl2Device under headless SwiftShader — the same software rasteriser the CI render-gate
// leg drives.

import { test, expect } from '@playwright/test'

// West fixture spans lon [-76.58, -75.78]; the twin abuts it at [-75.78, -74.98], so the
// frame's vertical midline is exactly the domain boundary and each half is one domain.
const CENTRE_LON = -75.78
const CENTRE_LAT = 38.17
const ZOOM = 7

const EAST_FIXTURE = '/data/synthetic-currents-east.h5'

/** `| arrow` is the static catalogue portrayal (CPU-symbolized per region); `| flow` resolves
 *  to the ADVECTED arrows (#1418's default), which is what binds a velocity pair per batch. */
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

const N = 96 // cells per axis

/** The live drawing buffer as a coarse grid of MEAN COLOUR per cell. Colour, not coverage:
 *  the whole failure is two fields that cover the same cells and disagree about which speed
 *  band is there. Returned per half so one domain cannot be averaged into the other. */
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
  const N = 96 // inlined: this function is serialized into the page, which has no module scope
  const cells = new Float64Array(N * N)
  const counts = new Float64Array(N * N)
  let west = 0
  let east = 0
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
        cells[c]! += (r + 2 * g + 4 * b) / 7
        if (x < W / 2) west++
        else east++
      }
    }
  }
  for (let c = 0; c < cells.length; c++) cells[c]! /= Math.max(1, counts[c]!)
  return {
    ok: true as const,
    backend: w.__xgisMap?.ctx?.rhi?.backend,
    W,
    H,
    paintedWest: west / ((W * H) / 2),
    paintedEast: east / ((W * H) / 2),
    cells: Array.from(cells),
  }
}

/** Mean absolute per-cell colour difference over ONE half — `half` 0 = west, 1 = east. */
function halfDiff(a: number[], b: number[], half: 0 | 1): number {
  let s = 0
  let n = 0
  for (let cy = 0; cy < N; cy++) {
    const from = half === 0 ? 0 : N / 2
    for (let cx = from; cx < from + N / 2; cx++) {
      const i = cy * N + cx
      s += Math.abs(a[i]! - b[i]!)
      n++
    }
  }
  return s / n
}

async function boot(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 900, height: 700 })
  // The basemap would paint every pixel and make every number here vacuous — the claim is about
  // ARROWS. A regex, not a glob: the host is one path segment (#1272's spec pays for that one).
  await page.route(/arcgisonline\.com/, (r) => void r.abort())
  // `adaptive=0` PINS THE RESOLUTION. The advected field animates every frame, so the quality
  // ladder steps DPR down under sustained load and every pixel then changes for a reason that
  // has nothing to do with which field an arrow read (#1419's gate records the measurement).
  await page.goto(
    `/demo.html?id=s111_currents&forcegl2=1&e2e=1&adaptive=0#${ZOOM}/${CENTRE_LAT}/${CENTRE_LON}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 20000 },
  )
}

/** Swap the running style, wait for the declared coverage, then push the EASTERN twin under its
 *  own region key and wait for it too. Both regions resident is the whole premise. */
async function mosaic(page: import('@playwright/test').Page, layer: '| arrow' | '| flow') {
  await page.evaluate(async (s) => {
    const w = window as unknown as { __xgisRunSource?: (s: string) => Promise<unknown> }
    await w.__xgisRunSource!(s)
  }, style(layer))
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __xgisMap?: { getCoverage(id: string): unknown } }
      ).__xgisMap?.getCoverage('currents') != null,
    { timeout: 20000 },
  )
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
    if (!res.ok) throw new Error(`east fixture ${file}: HTTP ${res.status}`) // loud, not silent
    await w.__xgisMap!.setCoverageData('currents', await res.arrayBuffer(), {
      region: 'east',
      url: file,
    })
    w.__xgisMap!.invalidate?.()
  }, EAST_FIXTURE)
  await page.waitForTimeout(1500)
}

test.describe('S-111 mosaic — each domain’s arrows read their own field (#1458)', () => {
  test('the east domain’s advected field matches its OWN catalogue, not the west’s', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    await boot(page)

    // ── The STATIC mosaic: the CPU catalogue portrayal, per region, by construction. ──
    await mosaic(page, '| arrow')
    const staticA = await page.evaluate(readHalves)
    expect(staticA.ok, 'WebGL2 context present').toBe(true)
    if (!staticA.ok) return
    // Asserted, not assumed: a silent fallback to the other backend would green this gate on a
    // path CI never runs.
    expect(staticA.backend, 'running on the WebGL2 backend').toBe('webgl2')
    await page.screenshot({ path: 'test-results/s111-mosaic-static.png' })

    // ── The NOISE FLOOR of the comparison: the same static mosaic, captured again. Measured
    //    before any bound is read, because a ratio against an unmeasured floor is a guess. ──
    await mosaic(page, '| arrow')
    const staticB = await page.evaluate(readHalves)
    expect(staticB.ok).toBe(true)
    if (!staticB.ok) return
    const floorW = halfDiff(staticA.cells, staticB.cells, 0)
    const floorE = halfDiff(staticA.cells, staticB.cells, 1)

    // ── The ADVECTED mosaic. Frame 0 of the advected field IS the static placement, so this is
    //    a parity comparison and not a snapshot of some later instant. ──
    await mosaic(page, '| flow')
    const adv = await page.evaluate(readHalves)
    expect(adv.ok).toBe(true)
    if (!adv.ok) return
    await page.screenshot({ path: 'test-results/s111-mosaic-advected.png' })

    const parityW = halfDiff(staticA.cells, adv.cells, 0)
    const parityE = halfDiff(staticA.cells, adv.cells, 1)

    console.log(
      `[s111-mosaic-field] floor W=${floorW.toFixed(4)} E=${floorE.toFixed(4)} | ` +
        `parity W=${parityW.toFixed(4)} E=${parityE.toFixed(4)} | ` +
        `E/W=${(parityE / Math.max(parityW, 1e-6)).toFixed(2)} | ` +
        `painted static W=${staticA.paintedWest.toFixed(3)} E=${staticA.paintedEast.toFixed(3)} ` +
        `adv W=${adv.paintedWest.toFixed(3)} E=${adv.paintedEast.toFixed(3)}`,
    )

    // PRECONDITIONS. Each of these fails FIRST and names its own reason, rather than surfacing
    // as an inscrutable ratio: a half that never drew, or a mosaic that lost a domain, would
    // otherwise make the comparison below trivially green.
    expect(staticA.paintedWest, 'static: west domain drew').toBeGreaterThan(0.01)
    expect(staticA.paintedEast, 'static: east domain drew — is the twin resident?').toBeGreaterThan(
      0.01,
    )
    expect(adv.paintedWest, 'advected: west domain drew').toBeGreaterThan(0.01)
    expect(adv.paintedEast, 'advected: east domain drew').toBeGreaterThan(0.01)

    // THE CLAIM. The west half is the control — it is the first region armed, so it binds its
    // own field in the broken world too. The east half must not be materially worse than it.
    //
    // Measured on BOTH sides before the bound was chosen, by reverting `arrowBindingFor` to the
    // one-field behaviour this issue fixes:
    //
    //            parity W    parity E    E/W
    //   fixed      6.3336      6.3125   1.00
    //   broken     6.4465     23.2005   3.60
    //
    // The control barely moves (6.33 → 6.45) and only the treatment blows up, which is what
    // licenses reading the ratio at all. Bound at the GEOMETRIC MIDPOINT, 1.90 — 90% either
    // way, so a regression must give back most of the separation to pass. Not 3.0: that was the
    // first draft, it passed, and it still sat 17% from the broken number — the bound shape that
    // makes a gate flake (§12).
    //
    // The absolute parity of ~6.3 is NOT the signal and is not asserted: the advected frame is
    // sampled after the field has drifted, so it differs from the static placement everywhere by
    // construction. Only the asymmetry between the halves is the claim.
    expect(
      parityE / Math.max(parityW, 1e-6),
      'the east domain’s advected symbology disagrees with its own catalogue far more than the ' +
        'west control does — it is reading another domain’s velocity field (#1458)',
    ).toBeLessThan(1.9)
  })
})
