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
// THE MEASURE IS A CHROMATICITY DISTANCE per half — each half of the advected mosaic against the
// SAME half of the STATIC `| arrow` mosaic, which reads each region's own handle by construction.
// The WEST half is the CONTROL: it is the first region armed, so it binds its own field in the
// broken world too, and its number is the noise floor of the comparison itself. The EAST half is
// the treatment. Fixed, both agree; broken, only the east one blows up.
//
// IT WAS A PER-CELL PARITY RATIO, and view-driven density (#1450 B) ended that. The advected
// field now draws a thinned subset of the cells while the static one does not, so a cell-by-cell
// comparison between them measures which POSITIONS each drew — the absolute parity went 6.3 → 48.9
// with nothing wrong. The ratio still read 0.36 and still "passed", which is the danger: the band
// shift this gate exists to see is worth ~17 in those units and was about to be buried under a
// density mismatch three times its size. Chromaticity asks the same question with the density
// divided out, and it separates 0.0000 from 0.2041 instead.
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
  const sw = [0, 0, 0]
  const se = [0, 0, 0]
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
        if (x < W / 2) {
          west++
          sw[0]! += r
          sw[1]! += g
          sw[2]! += b
        } else {
          east++
          se[0]! += r
          se[1]! += g
          se[2]! += b
        }
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
    // Mean colour over the PAINTED pixels of each half — the density-immune form of the same
    // "which band is this domain painting" question the cell grid asks. It has to be
    // density-immune now: the advected field thins to the view (#1450 B) while the static one
    // does not, so a per-cell comparison between them is dominated by which POSITIONS each drew
    // long before it says anything about which BAND. Averaging over painted pixels divides that
    // out — an east domain reading the west field is a mottle of low bands whatever its density.
    meanWest: [sw[0]! / Math.max(1, west), sw[1]! / Math.max(1, west), sw[2]! / Math.max(1, west)],
    meanEast: [se[0]! / Math.max(1, east), se[1]! / Math.max(1, east), se[2]! / Math.max(1, east)],
  }
}

/** Distance between two mean colours as CHROMATICITY — each normalized by its own sum first.
 *
 *  Raw mean colour is not density-immune, which a first attempt at this gate found the hard way:
 *  the static field paints 0.414 of its half and the thinned advected one 0.009, so a far larger
 *  fraction of the sparse field's painted pixels are anti-aliased glyph edges and black outline.
 *  Both halves then read ~30 units apart WHEN CORRECT — the same size as the band shift being
 *  looked for. Dividing each mean by its own total removes the brightness the coverage carries
 *  and keeps only the hue, which is what a speed BAND actually is here: the west fixture's low
 *  bands are blue-cyan (0.22, 0.30, 0.48) and the east twin's flat 6.5 kn top band is
 *  yellow (0.51, 0.49, 0.00). */
const colorDist = (a: number[], b: number[]): number => {
  const n = (c: number[]): number[] => {
    const s = Math.max(1e-9, c[0]! + c[1]! + c[2]!)
    return [c[0]! / s, c[1]! / s, c[2]! / s]
  }
  const [ar, ag, ab] = n(a) as [number, number, number]
  const [br, bg, bb] = n(b) as [number, number, number]
  return Math.hypot(ar - br, ag - bg, ab - bb)
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

    const dW = colorDist(adv.meanWest, staticA.meanWest)
    const dE = colorDist(adv.meanEast, staticA.meanEast)

    console.log(
      `[s111-mosaic-field] floor W=${floorW.toFixed(4)} E=${floorE.toFixed(4)} | ` +
        `parity W=${parityW.toFixed(4)} E=${parityE.toFixed(4)} | ` +
        `dChroma W=${dW.toFixed(4)} E=${dE.toFixed(4)} | ` +
        `mean static W=[${staticA.meanWest.map((v) => v.toFixed(0))}] ` +
        `E=[${staticA.meanEast.map((v) => v.toFixed(0))}] ` +
        `adv W=[${adv.meanWest.map((v) => v.toFixed(0))}] ` +
        `E=[${adv.meanEast.map((v) => v.toFixed(0))}] | ` +
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
    // 0.005, not the 0.01 this shipped with: the advected field now thins to the view (#1450 B)
    // and at this gate's z7 the west half legitimately paints 0.009. The assertion's job — "the
    // domain is on screen at all" — is unchanged.
    expect(adv.paintedWest, 'advected: west domain drew').toBeGreaterThan(0.005)
    expect(adv.paintedEast, 'advected: east domain drew').toBeGreaterThan(0.005)

    // THE CLAIM, and WHY IT IS NOW A COLOUR DISTANCE rather than the parity ratio this shipped
    // with. The ratio compared static and advected CELL BY CELL. That was sound while both drew
    // one arrow per cell; view-driven density (#1450 B) broke the premise — the advected field
    // draws a thinned subset, so the per-cell parity is dominated by WHICH POSITIONS each field
    // drew and the absolute numbers went from ~6.3 to ~48. The ratio still reads 0.36, i.e. still
    // "passes", which is exactly the danger: the signal this gate exists to see is a band shift
    // of ~17 units, and it was about to be buried under a density mismatch eight times its size.
    //
    // Mean colour over painted pixels is the same question with the density divided out. The
    // discriminator is untouched and is still the fixture's: the east twin is a FLAT 6.5 kn field
    // (one uniform top band), the west is 0.037–1.904 kn (a mottle of low bands), so an east
    // domain reading the WEST field paints unmistakably different colours whatever its density.
    //
    // Measured on BOTH sides before the bound was chosen, by reverting `arrowBindingFor` to the
    // one-field behaviour #1458 fixes (`const field = [...this.arrowFields.values()][0]`):
    //
    //            dChroma W   dChroma E    east mean colour
    //   fixed       0.0162      0.0000    [149, 140,  0]  ← the flat 6.5 kn top band, yellow
    //   broken      0.0162      0.2041    [ 99, 130, 38]  ← the west field's low bands, mottled
    //
    // The control is IDENTICAL to four digits in both worlds, which is what licenses reading the
    // east number at all: the west half is the first region armed, so it binds its own field even
    // when broken. Only the treatment moves, and it moves by 12× the control's own floor.
    //
    // Bound at 0.05 — 4× under the broken value and 3× over the control's noise. Not a geometric
    // midpoint, because the fixed east number is 0.0000 and there is no midpoint to take; the
    // control's own disagreement is the honest floor to sit above.
    //
    // The absolute per-cell `parity` numbers are logged but NOT asserted. They were the claim
    // once; view-driven density made them meaningless (see above).
    expect(
      dW,
      'the WEST control disagrees with its own catalogue — the comparison itself is broken, ' +
        'not the east domain',
    ).toBeLessThan(0.05)
    expect(
      dE,
      'the east domain’s advected symbology disagrees with its own catalogue — it is reading ' +
        'another domain’s velocity field (#1458)',
    ).toBeLessThan(0.05)
  })
})
