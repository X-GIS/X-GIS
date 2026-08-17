// ═══ Each mosaic domain's IBFV trail is its OWN — rendered (#1499) ═══
//
// The TRAIL twin of `_s111-mosaic-arrow-field-gate` (#1458). That one proved a domain's ARROWS
// read their own velocity field; this one proves the same of the advected IMAGE the drape samples.
// Before #1499 the map held ONE `FlowStepper` — one ping-pong pair, one dt clock — stepped once a
// frame with `CoverageRenderer.activeFlowField()` (the FIRST resident region), and the coverage
// draw handed that single image to EVERY animated region.
//
// WHAT THE OBVIOUS GATE CANNOT SEE, and it is worth stating because it was the first thing tried:
// "both halves' pixels change between frames" is GREEN ON THE BROKEN CODE. The second domain's
// drape was bound to the first domain's trail, and that image animates — so the east half moves,
// beautifully, with the west's current. Nothing stands still; the wrong water moves. An assertion
// that cannot distinguish the two states carries no information (CLAUDE.md §12), so the motion
// check below is kept as a PRECONDITION and the witness is something else.
//
// THE WITNESS: on the broken code the two halves are THE SAME PICTURE. Both domains' meshes carry
// footprint-normalized grid uv, both footprints are 0.8° × 2.64° (the twin is the west fixture
// shifted east by exactly one width), and both carry the same validity mask — so one trail texture
// sampled through both meshes lands as one image translated by exactly the domain width. Under the
// fix the two halves are two independent recursive filters and disagree. So this gate compares the
// west half against the east half AT THE SAME INSTANT, aligned by the projected domain width.
//
// WHY THE FIXTURE DISCRIMINATES, measured off the files rather than assumed:
//
//   synthetic-currents.h5       origin lon −76.58, 32 × 0.025°, speed 0.037 … 1.904 kn (mean 0.71)
//   synthetic-currents-east.h5  origin lon −75.78 — exactly one width east — same direction field,
//                               speed a CONSTANT 6.5 kn over the same 1187 valid cells
//
// The components are normalized by each field's OWN peak before upload, so the east domain advects
// at the full display rate everywhere while the west advects at 0.37 of it on average and at
// almost nothing along its slack edges. Two different filters over the same noise: same picture is
// impossible, and the difference is largest exactly where the west field is slowest.
//
// THE MEASURE is a mean absolute luminance difference between the halves, NORMALIZED by the
// picture's own spread (its mean absolute deviation). Normalized because `| flow-streaks` is a
// deliberately dim, neutral-white modulation whose absolute level depends on the alpha the drape
// lands at; a raw difference would then be a brightness measurement wearing a pattern's clothes.
// Both numbers come from the same frame, so the ratio is immune to that and to the DPR.
//
// `| flow-streaks` and NO `ramp:`, deliberately: with a ramp the halves would differ by their
// VALUE fills (a 6.5 kn flat field against a 0.04–1.9 kn mottle) whether or not the trail was
// fixed, and this gate would be green on the broken code for a reason that has nothing to do with
// it. Flow-only paints neutral white modulated by the advected image alone, so the trail is the
// only thing the two halves can disagree about.
//
// On WebGl2Device under headless SwiftShader — the same software rasteriser the CI render-gate leg
// drives.

import { test, expect } from '@playwright/test'

/** The fixtures' OUTER edges, from their stored grid origins (`gridOriginLongitude` −76.58 /
 *  −75.78, spacing 0.025°) plus the half-cell every S-100 footprint extends past its nodes:
 *  west [−76.5925, −75.7925], east [−75.7925, −74.9925]. They ABUT at −75.7925 and each is
 *  exactly 0.8° wide, which is what makes one texture through two meshes a pure translation. */
const WEST_EDGE = -76.5925
const BOUNDARY = -75.7925
/** 48 × 0.055° from origin lat 36.85, half-cell either side → [36.8225, 39.4625]. */
const CENTRE_LAT = 38.1425
/** z8: 0.8° is 291 device px on X-GIS's 512-px-tile zoom (512 · 2^8 / 360 px per degree), so both
 *  domains sit inside a 900-px viewport with room to spare, and each is ~9 px per grid texel —
 *  wide enough that the 4-px binning below cannot smear the pattern away. */
const ZOOM = 8

const EAST_FIXTURE = '/data/synthetic-currents-east.h5'

/** The IBFV drape and nothing else. `| flow-streaks` is the portrayal that keeps the advected
 *  image itself (#1418); the default `| flow` resolves to moving ARROWS and draws no drape at
 *  all, which is a different layer and a different gate. */
const STYLE = `xgis 1

source currents {
  type: coverage
  url: "synthetic-currents.h5"
}

layer speed {
  source: currents
  | flow-streaks
}
`

interface Probe {
  westEdge: number
  boundary: number
  lat: number
  /** Frames to let pass between the two captures — the temporal arm's baseline. */
  settle: number
  /** Device-pixel bin edge. Averaging over a small block divides out the sub-device-pixel
   *  residue of rounding the projected domain width to an integer shift, while leaving the
   *  pattern (≈9 px per grid texel) intact. */
  bin: number
}

/** Everything this gate asserts, computed IN the page: two captures, the domain width taken from
 *  the map's own projection, and the halves compared block by block.
 *
 *  In the page rather than over the wire because the raw frame is megabytes and the comparison
 *  needs per-pixel correspondence, not a 96-cell summary. */
async function measure(k: Probe) {
  const w = window as unknown as {
    __xgisMap?: {
      project(lonLat: readonly [number, number]): [number, number] | null
      ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } }
    }
  }
  const map = w.__xgisMap
  const gl = map?.ctx?.rhi?.gl
  if (!map || !gl) return { ok: false as const, reason: 'no gl' }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  const canvas = gl.canvas as HTMLCanvasElement
  // `project` answers in canvas-local CSS px; readPixels is in device px.
  const scale = W / Math.max(1, canvas.clientWidth)
  const pw = map.project([k.westEdge, k.lat])
  const pb = map.project([k.boundary, k.lat])
  if (!pw || !pb) return { ok: false as const, reason: 'no projection' }
  const x0 = Math.round(pw[0] * scale)
  const shift = Math.round((pb[0] - pw[0]) * scale)
  // A PRECONDITION, not a guard: with a domain off screen or collapsed the comparison below
  // would be over a handful of background pixels and trivially green.
  if (shift < 64 || x0 < 0 || x0 + 2 * shift > W) {
    return { ok: false as const, reason: `domains off screen: x0=${x0} shift=${shift} W=${W}` }
  }

  const grab = (): Uint8Array => {
    const b = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b)
    return b
  }
  const nextFrames = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null)))
  }

  const a = grab()
  // Read twice with no frame in between: the readback's own floor, so "it moved" is measured
  // against a number rather than against zero-by-assumption.
  const aa = grab()
  await nextFrames(k.settle)
  const b = grab()

  // Block means of luminance. `(r + 2g + 4b) / 7` is the weighting the sibling S-111 gates use.
  const bins = (buf: Uint8Array, xFrom: number): Float64Array => {
    const cols = Math.floor(shift / k.bin)
    const rows = Math.floor(H / k.bin)
    const out = new Float64Array(cols * rows)
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        let s = 0
        for (let y = by * k.bin; y < (by + 1) * k.bin; y++) {
          for (let x = xFrom + bx * k.bin; x < xFrom + (bx + 1) * k.bin; x++) {
            const i = (y * W + x) * 4
            s += (buf[i]! + 2 * buf[i + 1]! + 4 * buf[i + 2]!) / 7
          }
        }
        out[by * cols + bx] = s / (k.bin * k.bin)
      }
    }
    return out
  }

  const mad = (p: Float64Array, q: Float64Array): number => {
    let s = 0
    for (let i = 0; i < p.length; i++) s += Math.abs(p[i]! - q[i]!)
    return s / Math.max(1, p.length)
  }
  const mean = (p: Float64Array): number => {
    let s = 0
    for (let i = 0; i < p.length; i++) s += p[i]!
    return s / Math.max(1, p.length)
  }
  /** Mean absolute deviation — the picture's OWN spread, and the normalizer. */
  const spread = (p: Float64Array): number => {
    const m = mean(p)
    let s = 0
    for (let i = 0; i < p.length; i++) s += Math.abs(p[i]! - m)
    return s / Math.max(1, p.length)
  }

  const west = bins(b, x0)
  const east = bins(b, x0 + shift)
  return {
    ok: true as const,
    backend: w.__xgisMap?.ctx?.rhi?.backend,
    W,
    H,
    x0,
    shift,
    meanWest: mean(west),
    meanEast: mean(east),
    spreadWest: spread(west),
    spreadEast: spread(east),
    /** The witness: the two halves at ONE instant, block for block. */
    crossHalf: mad(west, east),
    /** Each half against itself `settle` frames earlier — "it animates at all". */
    motionWest: mad(bins(a, x0), west),
    motionEast: mad(bins(a, x0 + shift), east),
    /** Readback noise: two captures with no frame between them. */
    floor: mad(bins(a, x0), bins(aa, x0)),
  }
}

async function boot(page: import('@playwright/test').Page) {
  // The demo page's fixed chrome consumes ~420 horizontal CSS px, so the CANVAS is the
  // viewport minus that (measured: 900 viewport → 480 canvas). The half-alignment below
  // needs x0 = canvasW/2 − 291 ≥ 0 and x0 + 2·291 ≤ canvasW, i.e. canvas ≥ ~600 px:
  // 1100 viewport → ~680 canvas → x0 ≈ 49 with symmetric margin.
  await page.setViewportSize({ width: 1100, height: 700 })
  // The basemap would paint every pixel and make every number here a measurement of imagery. A
  // regex, not a glob: the host is one path segment (#1272's spec pays for that one).
  await page.route(/arcgisonline\.com/, (r) => void r.abort())
  // `adaptive=0` PINS THE RESOLUTION. The trail animates every frame, so the quality ladder reads
  // the sustained load and steps DPR down — every pixel then changes, and the projected shift this
  // gate aligns the halves by would stop matching the buffer it is applied to.
  await page.goto(
    `/demo.html?id=s111_currents&forcegl2=1&e2e=1&adaptive=0#${ZOOM}/${CENTRE_LAT}/${BOUNDARY}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 20000 },
  )
}

/** The streaks style, then the EASTERN twin under its own region key. Both regions resident and
 *  both DRAPED is the whole premise: under the arrows portrayal they would be resident-but-hidden
 *  and no trail would be stepped for either. */
async function mosaic(page: import('@playwright/test').Page) {
  await page.evaluate(async (s) => {
    const w = window as unknown as { __xgisRunSource?: (s: string) => Promise<unknown> }
    await w.__xgisRunSource!(s)
  }, STYLE)
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
  // Long enough for both histories to reach the decay's steady state (0.96 per step ⇒ a ~25-frame
  // memory), which is when the two filters have had time to disagree.
  await page.waitForTimeout(2500)
}

/** THE BOUND, and the one thing in this file a measurement has to settle.
 *
 *  Broken, the halves are the same picture translated by an integer number of device pixels, so
 *  `crossHalf` is the sub-pixel residue of that rounding — near zero against a spread that is the
 *  full pattern. Fixed, the halves are two filters that share only their injected noise: the east
 *  domain advects at the full rate everywhere, the west at 0.37 of it on average and at almost
 *  nothing along its edges.
 *
 *  0.20 is derived from that asymmetry, NOT yet measured on both sides. Run this spec against
 *  `origin/main` (red) and this branch (green) and replace this paragraph with the two numbers,
 *  the way `_s111-mosaic-arrow-field-gate` records its 0.0000 / 0.2041 — a bound whose two ends
 *  were never measured is a guess with a decimal point on it. */
const CROSS_HALF_BOUND = 0.2

test.describe('S-111 mosaic — each domain advects its OWN trail (#1499)', () => {
  test('the two domains paint DIFFERENT advected images, not one image twice', async ({ page }) => {
    test.setTimeout(240_000)
    await boot(page)
    await mosaic(page)

    const m = await page.evaluate(measure, {
      westEdge: WEST_EDGE,
      boundary: BOUNDARY,
      lat: CENTRE_LAT,
      settle: 6,
      bin: 4,
    })
    expect(m.ok, `the probe could not measure: ${m.ok ? '' : m.reason}`).toBe(true)
    if (!m.ok) return
    // Asserted, not assumed: a silent fallback to the other backend would green this gate on a
    // path CI never runs.
    expect(m.backend, 'running on the WebGL2 backend').toBe('webgl2')
    await page.screenshot({ path: 'test-results/s111-mosaic-trail.png' })

    const rel = m.crossHalf / Math.max(1e-9, Math.min(m.spreadWest, m.spreadEast))
    console.log(
      `[s111-mosaic-trail] buffer=${m.W}x${m.H} x0=${m.x0} shift=${m.shift} | ` +
        `mean W=${m.meanWest.toFixed(2)} E=${m.meanEast.toFixed(2)} | ` +
        `spread W=${m.spreadWest.toFixed(3)} E=${m.spreadEast.toFixed(3)} | ` +
        `motion W=${m.motionWest.toFixed(3)} E=${m.motionEast.toFixed(3)} ` +
        `ratio=${(m.motionEast / Math.max(1e-9, m.motionWest)).toFixed(3)} | ` +
        `floor=${m.floor.toFixed(4)} crossHalf=${m.crossHalf.toFixed(3)} rel=${rel.toFixed(3)}`,
    )

    // ── PRECONDITIONS. Each fails FIRST and names its own reason, rather than surfacing as an
    //    inscrutable ratio: a half that never drew, or a flat wash with no pattern in it, would
    //    otherwise make the claim below trivially green. ──
    expect(m.meanWest, 'the west domain drew nothing').toBeGreaterThan(2)
    expect(m.meanEast, 'the east domain drew nothing — is the twin resident?').toBeGreaterThan(2)
    expect(m.spreadWest, 'the west half is a flat wash — no trail in it').toBeGreaterThan(1)
    expect(m.spreadEast, 'the east half is a flat wash — no trail in it').toBeGreaterThan(1)
    // BOTH halves animate. Green on the broken code too — the east half was bound to the west's
    // trail and moved with it — so this is a precondition, never the claim. It is still worth
    // asserting: a dead trail would make `crossHalf` a comparison of two frozen images.
    const moved = Math.max(4 * m.floor, 0.5)
    expect(m.motionWest, 'the west domain’s trail is frozen').toBeGreaterThan(moved)
    expect(m.motionEast, 'the east domain’s trail is frozen').toBeGreaterThan(moved)

    // ── THE CLAIM. The east half is not the west half. ──
    expect(
      rel,
      'the two domains are painting the SAME advected image — the mosaic is stepping one trail ' +
        'and binding it everywhere, so every domain but the first shows another domain’s water ' +
        '(#1499)',
    ).toBeGreaterThan(CROSS_HALF_BOUND)
  })
})
