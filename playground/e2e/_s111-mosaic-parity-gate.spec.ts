// ═══ In a MOSAIC, every region's advected frame 0 must match ITS OWN catalogue placement ═══
//
// The claim `_s111-advected-arrows-gate` makes for one region, made per region: the origins seed
// the position state, so before anything has drifted the advected path must draw what `| arrow`
// draws — same cells, same band colours, same per-band sizes.
//
// WHY A SECOND GATE RATHER THAN A WIDER FIRST ONE. The single-region parity claim is satisfied
// by a batch that reads texel `instance_index`, which is exactly the pre-#1458 behaviour: with
// one region there is nothing to collide with. The mosaic failure only exists once a SECOND
// region's batch indexes the same shared state, and what it corrupts is not where the arrows
// are — screen position comes from the CPU-packed per-instance lon/lat — but the uv the velocity
// textures are sampled at, hence the band COLOUR, the heading and the scale.
//
// So the statistic is deliberately a RATIO BETWEEN THE TWO HALVES, not an absolute parity:
//
//     parityNorth = |advected frame 0 − static| over the northern (first-armed) domain
//     parityRatio = parityRatio(south) / parityRatio(north)
//
// The first-armed region is based at texel 0 whether or not the fix is present, so it stays
// correct in both worlds and acts as the control. The second region is the one whose base is
// non-zero — it agrees with its own static placement when each region reads its own range, and
// disagrees when it reads the first region's. A ratio needs no tuned threshold and cannot be
// satisfied by "everything got worse together" (a resolution change, a camera drift, a colour
// pipeline regression), which would move both halves alike.
//
// THE FIXTURE MATTERS AND WAS PAID FOR. `synthetic-currents-east.h5` cannot discriminate
// anything: it is the 32×48 field translated, so both domains carry identical grid-uv origins
// and one overwriting the other writes the same numbers back. `synthetic-currents-south.h5` is
// 23×29 with a different coast mask — 467 valid cells against 1187 — so the two domains disagree
// about both their arrow count and their origins. A coverage-based gate is blind here either
// way; see `_s111-mosaic-advected-gate.spec.ts`'s header for that finding.

import { test, expect } from '@playwright/test'

// Framed to hold both domains, split by the horizontal midline: the 32×48 Chesapeake field
// (lat 36.85–39.49) above, the 23×29 southern one (lat 34.90–36.26) below.
const ZOOM = 6
const CENTRE_LAT = 37.2
const CENTRE_LON = -76.2
const SOUTH_FIXTURE = '/data/synthetic-currents-south.h5'
const SETTLE_MS = Number(process.env.XGIS_SETTLE_MS ?? 900)

/** One layer over the demo's declared coverage and nothing else — every painted pixel is an
 *  arrow. `| arrow` is the static catalogue portrayal; `| flow` resolves to the advected one. */
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

/** The drawing buffer as a coarse COLOUR grid, split into the southern and northern halves.
 *  `readPixels` origin is bottom-left, so rows below N/2 are the southern domain. Colour rather
 *  than coverage: two fields can cover the same cells and still disagree about which speed band
 *  is there, which is the whole failure mode here. */
function readHalfGrids() {
  const w = window as unknown as {
    __xgisMap?: { ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } } }
  }
  const gl = w.__xgisMap?.ctx?.rhi?.gl
  if (!gl) return { ok: false as const, reason: 'no gl' }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  const buf = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  const N = 96
  const cells = new Float64Array(N * N)
  const counts = new Float64Array(N * N)
  let paintedSouth = 0
  let paintedNorth = 0
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
        if (y < H / 2) paintedSouth++
        else paintedNorth++
        cells[c]! += (r + 2 * g + 4 * b) / 7
      }
    }
  }
  for (let c = 0; c < cells.length; c++) cells[c]! /= Math.max(1, counts[c]!)
  const half = (N / 2) * N
  return {
    ok: true as const,
    backend: w.__xgisMap?.ctx?.rhi?.backend,
    south: Array.from(cells.subarray(0, half)),
    north: Array.from(cells.subarray(half)),
    paintedSouth: paintedSouth / ((W * H) / 2),
    paintedNorth: paintedNorth / ((W * H) / 2),
  }
}

/** Mean absolute per-cell difference — the directional metric every claim here is stated in. */
const diff = (a: number[], b: number[]): number => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!)
  return s / a.length
}

async function boot(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 900, height: 700 })
  // A regex, not a glob — the host is one path segment. Without this the basemap paints every
  // pixel and every number below is vacuous.
  await page.route(/arcgisonline\.com/, (r) => void r.abort())
  // `adaptive=0` pins the resolution. The advected field animates every frame, so the quality
  // ladder steps DPR down within seconds and every pixel then changes for a reason that has
  // nothing to do with arrows — which would contaminate a comparison between two captures.
  await page.goto(
    `/demo.html?id=s111_currents&forcegl2=1&e2e=1&adaptive=0#${ZOOM}/${CENTRE_LAT}/${CENTRE_LON}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 20000 },
  )
}

/** Swap the running style, wait for the declared coverage, then push the SECOND domain. */
async function runWithBothDomains(page: import('@playwright/test').Page, src: string) {
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
  await page.waitForTimeout(SETTLE_MS)
}

test.describe('S-111 mosaic parity — each region advects against its OWN placement (#1458)', () => {
  // KNOWN RED on main, and that is the point of committing it. Measured here:
  //
  //   settle 120 ms: parity S=2.5054 N=0.1676  S/N=14.95
  //   settle 900 ms: parity S=2.6588 N=0.3931  S/N= 6.76
  //
  // The southern (second-armed) domain disagrees with its own static placement by ~2.5 at
  // essentially frame 0, and the settle time barely moves it — only the northern control's
  // number grows with drift. So this is NOT a timing confound: the second region's advected
  // field is wrong from the first frame, while the first region's is right.
  //
  // #1459 gave each region its own texel range and is verified at the unit level, so this says
  // the range was necessary but not sufficient. The cause is NOT yet identified — candidates
  // are the second batch's band-table params (peak speed / uvAspect are per batch), the origin
  // upload for a region whose base is non-zero, or something else entirely. Do not guess from a
  // static read; this codebase punishes that.
  //
  // Marked `fail` so it reports the defect without turning the render-gate leg red. Flip it to
  // a plain `test` in the change that fixes it — a passing `test.fail` is itself an error, so
  // this cannot be forgotten.
  test.fail()
  test('the second domain matches its static field as well as the first does', async ({ page }) => {
    test.setTimeout(180_000)
    await boot(page)

    // ── REFERENCE: the static catalogue portrayal, both domains. ──
    await runWithBothDomains(page, style('| arrow'))
    const stat = await page.evaluate(readHalfGrids)
    expect(stat.ok, 'WebGL2 context present').toBe(true)
    if (!stat.ok) return
    expect(stat.backend, 'WebGL2 backend — a silent fallback cannot green this').toBe('webgl2')
    await page.screenshot({ path: 'test-results/s111-mosaic-parity-static.png' })

    // ── NOISE FLOOR: the same configuration again. Measured, never assumed — every ratio
    //    below is meaningless without knowing what "no change at all" costs. ──
    await runWithBothDomains(page, style('| arrow'))
    const again = await page.evaluate(readHalfGrids)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    const floorS = diff(stat.south, again.south)
    const floorN = diff(stat.north, again.north)

    // ── EXPERIMENT: the advected portrayal, captured at frame 0 — which IS the static
    //    placement, by construction (the origins seed the position state). ──
    await runWithBothDomains(page, style('| flow'))
    const adv = await page.evaluate(readHalfGrids)
    expect(adv.ok).toBe(true)
    if (!adv.ok) return
    await page.screenshot({ path: 'test-results/s111-mosaic-parity-advected.png' })

    const pS = diff(stat.south, adv.south)
    const pN = diff(stat.north, adv.north)
    const ratio = pS / Math.max(pN, 1e-9)
    console.log(
      `[s111-mosaic-parity] floor S=${floorS.toFixed(4)} N=${floorN.toFixed(4)} | ` +
        `parity S=${pS.toFixed(4)} N=${pN.toFixed(4)} | S/N=${ratio.toFixed(3)} | ` +
        `painted static S=${stat.paintedSouth.toFixed(4)} N=${stat.paintedNorth.toFixed(4)} ` +
        `adv S=${adv.paintedSouth.toFixed(4)} N=${adv.paintedNorth.toFixed(4)}`,
    )

    // PRECONDITIONS. Both domains must actually be drawing in BOTH portrayals — otherwise a
    // page that rendered half of nothing satisfies a ratio of 1 perfectly.
    expect(stat.paintedSouth, 'static: southern domain drawn').toBeGreaterThan(0.002)
    expect(stat.paintedNorth, 'static: northern domain drawn').toBeGreaterThan(0.002)
    expect(adv.paintedSouth, 'advected: southern domain drawn').toBeGreaterThan(0.002)
    expect(adv.paintedNorth, 'advected: northern domain drawn').toBeGreaterThan(0.002)

    // THE CLAIM. The northern domain is armed first and therefore based at texel 0 in every
    // world, so it is the control: whatever parity the advected path achieves there is what a
    // correctly-based region achieves. The southern domain must not be materially worse.
    expect(ratio, 'the second domain parses its own state as well as the first').toBeLessThan(2)
  })
})
