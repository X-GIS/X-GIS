// ═══ Overlapping mosaic domains draw ONE arrow field, not two (#1585) ═══
//
// Two S-111 domains whose footprints overlap each enumerate a full screen lattice over the shared
// water. Before this fix both drew there, so the overlap carried two interleaved fields — roughly
// double the glyph density, in two domains' colours and headings at once. On a chart that is a
// misreading rather than a blemish, and the repo already says so: `arrow-drift.ts` derives
// `ARROW_LATTICE_FACTOR` precisely because "overlapping SCAROW symbols read as a faster current
// than the data says".
//
// THE TIE IS BROKEN THE WAY THE ENGINE ALREADY BREAKS IT. `coverage-bounds.ts` resolves a point
// claimed by two regions to the FIRST-ARMED one, and `coverageHandleAt` returns that region's
// value. So the fix makes the DRAWN field agree with the QUERIED value; before it, `getCoverage(at)`
// and the arrows over that same water could disagree about which domain is there.
//
// WHY THE EXISTING MULTIREGION GATE CANNOT SEE THIS. `_s111-multiregion-gate` builds its twin as the
// west fixture "shifted east by exactly its own width (so the two abut)" — with no shared ground,
// no region can draw on another's water, so that arrangement is structurally blind here. This one
// uses a twin shifted by HALF a width, which is the real NOAA shape (cbofs ∩ dbofs; wcofs ⊃ sfbofs).
//
// THE MEASURE IS CHROMATICITY PER BAND, not a pixel count. The overlap fixture is a CONSTANT
// 6.5 kn due east; the west fixture peaks at ~1.9 kn flowing broadly north. So the two are far
// apart in band colour, and the question "whose field is painted in the shared band" is answered by
// which exclusive band the shared band's colour matches. A count gate would pass on a broken image
// (§12), and density alone is the very thing the bug perturbs — chromaticity divides it out, the
// same reason `_s111-mosaic-arrow-field-gate` measures colour.
//
// On WebGl2Device under headless SwiftShader — the same software rasteriser the CI render-gate leg
// drives.

import { test, expect } from '@playwright/test'

// West fixture node box: lon [-76.58, -75.805]. The overlap twin is shifted by half that span
// (31 × 0.025 / 2 = 0.3875), so its node box is [-76.1925, -75.4175]. That splits the pair into
// three bands of equal width, which is what makes the three-way comparison below legible:
//
//   WEST-ONLY  [-76.58,   -76.1925]   west's mottled low-speed field
//   SHARED     [-76.1925, -75.805 ]   claimed by both — the west owns it, being armed first
//   TWIN-ONLY  [-75.805,  -75.4175]   the twin's uniform 6.5 kn
const WEST_W = -76.58
const SHARED_W = -76.1925
const SHARED_E = -75.805
const TWIN_E = -75.4175
const CENTRE_LON = (WEST_W + TWIN_E) / 2
const CENTRE_LAT = 38.14
const ZOOM = 8

const OVERLAP_FIXTURE = '/data/synthetic-currents-overlap.h5'

/** Mean colour and painted fraction over three LON bands, projected to screen x through the live
 *  camera so the bands follow the domains rather than the viewport.
 *
 *  Colour over PAINTED pixels only — the density-immune form. Density is reported alongside but is
 *  the weaker signal here precisely because it is what the bug moves; the colour is what says WHOSE
 *  field is on that water. */
function readBands(edges: number[]) {
  const w = window as unknown as {
    __xgisMap?: {
      ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } }
      project?: (lonLat: readonly [number, number]) => [number, number] | null
    }
  }
  const map = w.__xgisMap
  const gl = map?.ctx?.rhi?.gl
  if (!gl) return { ok: false as const, reason: 'no gl' }
  if (!map?.project) return { ok: false as const, reason: 'no project' }
  // CSS px → device px, against the CANVAS's own width. NOT `window.innerWidth`: the demo page
  // puts a code editor beside the map, so the canvas is roughly half the window — scaling by the
  // window squashed every band into the left third of the frame and sampled the wrong domains
  // entirely, while still producing plausible-looking numbers.
  const canvas = gl.canvas as HTMLCanvasElement
  const cssW = canvas.clientWidth || gl.drawingBufferWidth
  const xs: number[] = []
  for (const lon of edges) {
    const p = map.project([lon, 38.14])
    if (!p) return { ok: false as const, reason: `unprojectable lon ${lon}` }
    xs.push(p[0] * (gl.drawingBufferWidth / cssW))
  }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  const buf = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  const nB = xs.length - 1
  const sum = Array.from({ length: nB }, () => [0, 0, 0])
  const painted = new Array<number>(nB).fill(0)
  const total = new Array<number>(nB).fill(0)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let b = -1
      for (let k = 0; k < nB; k++) if (x >= xs[k]! && x < xs[k + 1]!) b = k
      if (b < 0) continue
      total[b]! += 1
      const i = (y * W + x) * 4
      const r = buf[i]!
      const g = buf[i + 1]!
      const bl = buf[i + 2]!
      if (r > 24 || g > 24 || bl > 24) {
        painted[b]! += 1
        sum[b]![0]! += r
        sum[b]![1]! += g
        sum[b]![2]! += bl
      }
    }
  }
  return {
    ok: true as const,
    backend: w.__xgisMap?.ctx?.rhi?.backend,
    W,
    H,
    xs,
    ink: painted.map((p, i) => p / Math.max(1, total[i]!)),
    mean: sum.map((s, i) => s.map((c) => c / Math.max(1, painted[i]!))),
  }
}

/** Euclidean distance between two mean colours, normalized to their own magnitude — a
 *  CHROMATICITY comparison, so a band that is merely darker (fewer glyphs) does not read as a
 *  different domain. */
function chromaDist(a: number[], b: number[]): number {
  const na = Math.hypot(...a) || 1
  const nb = Math.hypot(...b) || 1
  return Math.hypot(...a.map((v, i) => v / na - b[i]! / nb))
}

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

async function boot(page: import('@playwright/test').Page): Promise<void> {
  await page.setViewportSize({ width: 900, height: 700 })
  // BLOCK the satellite basemap. Imagery paints every pixel, which would saturate every band's
  // colour and ink and collapse the comparison to noise — the exact way `_s111-multiregion-gate`
  // once passed locally and failed on CI. A REGEX, not a glob: `**/arcgisonline.com/**` does not
  // match `server.arcgisonline.com`, since the host is one path segment rather than two.
  await page.route(/arcgisonline\.com/, (r) => void r.abort())
  // `adaptive=0` pins the DPR (the quality ladder would otherwise converge the field like a
  // zoom-out and fake the density half of this); `animt` pins the clock so the capture is
  // reproducible rather than needing settling.
  await page.goto(
    `/demo.html?id=s111_currents&forcegl2=1&e2e=1&adaptive=0&animt=0#${ZOOM}/${CENTRE_LAT}/${CENTRE_LON}`,
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

test.describe('S-111 overlapping domains — one field, first-armed owns it (#1585)', () => {
  test('the shared band carries the FIRST-armed domain’s field, not both', async ({ page }) => {
    test.setTimeout(180_000)
    const EDGES = [WEST_W, SHARED_W, SHARED_E, TWIN_E]

    await boot(page)
    const single = await page.evaluate(readBands, EDGES)
    expect(single.ok, 'WebGL2 context and projector present').toBe(true)
    if (!single.ok) return
    expect(single.backend, 'running on the WebGL2 backend').toBe('webgl2')
    // PRECONDITION: the west domain actually paints all three bands' worth of water before the
    // twin lands. Without this a suppression bug and an unloaded fixture look identical.
    expect(single.ink[0]!, 'control: the west domain paints its own band').toBeGreaterThan(0.002)
    await page.screenshot({ path: 'test-results/s111-overlap-single.png' })

    // ── Push the OVERLAPPING twin under its own region key, armed SECOND. ──
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
      if (!res.ok) throw new Error(`overlap fixture ${file}: HTTP ${res.status}`) // loud, not silent
      await w.__xgisMap!.setCoverageData('currents', await res.arrayBuffer(), {
        region: 'overlap',
        url: file,
      })
      w.__xgisMap!.invalidate?.()
    }, OVERLAP_FIXTURE)
    await page.waitForTimeout(1800)

    const both = await page.evaluate(readBands, EDGES)
    expect(both.ok).toBe(true)
    if (!both.ok) return
    await page.screenshot({ path: 'test-results/s111-overlap-both.png' })

    const [westOnly, shared, twinOnly] = both.mean as [number[], number[], number[]]
    const dWest = chromaDist(shared, westOnly)
    const dTwin = chromaDist(shared, twinOnly)
    console.log(
      `[s111-overlap] ink west=${both.ink[0]!.toFixed(4)} shared=${both.ink[1]!.toFixed(4)} ` +
        `twin=${both.ink[2]!.toFixed(4)} | chroma shared↔west=${dWest.toFixed(4)} ` +
        `shared↔twin=${dTwin.toFixed(4)} | bands x=${both.xs.map((v) => v.toFixed(0)).join(',')}`,
    )

    // PRECONDITION: the twin actually landed. Its exclusive band must look nothing like the west
    // domain, or the fixtures are not discriminating and everything below is vacuous.
    expect(
      chromaDist(twinOnly, westOnly),
      'the two fixtures must be far apart in colour, or this gate proves nothing',
    ).toBeGreaterThan(0.05)

    // THE CLAIM. The shared band belongs to the FIRST-armed domain, so its colour must sit with
    // the west band and away from the twin's. A RATIO between measured bands, not an absolute
    // threshold — the two distances are read off the same frame, so the comparison carries no
    // calibration of its own to drift (§12).
    expect(
      dWest,
      `the shared band reads as the west domain (${dWest.toFixed(4)} vs twin ${dTwin.toFixed(4)})`,
    ).toBeLessThan(dTwin)

    // …and the density says the same thing independently: one field over the shared water, not
    // two. MEASURED on both sides of the fix rather than guessed — with the cull the shared band
    // sits at 1.02× its owner's, without it at 2.47× — so 1.35 separates the two states with room
    // on each side rather than being a threshold picked to pass.
    expect(
      both.ink[1]!,
      'the shared band is not double-drawn relative to the domain that owns it',
    ).toBeLessThan(both.ink[0]! * 1.35)
  })
})
