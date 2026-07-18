// ═══ INC-A gate 3 — S-100 coverage colour-ramp headed readback (#1158) ═══
//
// PENDING (test.fixme): the coverage GPU draw is not yet wired into the render loop
// in THIS environment (no real GPU here; gate 3 is headed-only). The renderer,
// shader (WGSL+GLSL), f16 packing, and LUT bake are complete and unit-tested
// (coverage-ramp.test.ts / coverage-material.test.ts / coverage-webgl2-r16f.test.ts);
// what remains is the map.ts render-loop draw dispatch + camera MVP. Un-fixme these
// once that lands and run headed. NEVER report this green until it actually passes.
//
// Fixture: playground/public/synthetic-bathymetry.xgcov — a 32×32 grid at 50-58°N,
// depth ramp 0→40 m north→south, a nodata hole (rows/cols 13-18), and 4 KNOWN corner
// cells: NW=5, NE=15, SW=25, SE=35 m. range [0,40] ⇒ t = depth/40, sampled from the
// 'bathymetry' LUT. The inverse-Mercator row mapping (A4) is exercised at 58°N.

import { test, expect } from '@playwright/test'

// Expected ramp coordinate t = (depth − rangeLo)/(rangeHi − rangeLo), range [0,40].
const KNOWN = [
  { corner: 'NW', depth: 5, t: 5 / 40 },
  { corner: 'NE', depth: 15, t: 15 / 40 },
  { corner: 'SW', depth: 25, t: 25 / 40 },
  { corner: 'SE', depth: 35, t: 35 / 40 },
]

test.describe('coverage colour-ramp render (gate 3 — headed, PENDING)', () => {
  // The GPU draw dispatch is not yet wired (see header). test.fixme keeps this spec
  // authored + navigable but expected-to-fail until the headed draw lands.
  test.fixme()

  test('interior known-value cells read back ramp(value) within ±2/255 per channel', async ({
    page,
  }) => {
    test.setTimeout(30_000)
    await page.setViewportSize({ width: 1024, height: 1024 })
    await page.goto('/demo.html?id=coverage_bathymetry&e2e=1', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 15_000 },
    )

    // For each known corner cell: project its lon/lat centre to a pixel, read the
    // canvas texel, and assert it equals the 'bathymetry' LUT at t within LUT
    // tolerance (±2/255 per channel — the end-to-end error is provably sub-bin, A3).
    for (const k of KNOWN) {
      const rgba = await page.evaluate((_corner) => {
        // host reads map.getCoverage(...) + the LUT + projects the cell centre;
        // returns [r,g,b,a] at that pixel. (Implemented in the headed harness.)
        return (
          window as unknown as { __readCoverageTexel?: (c: string) => number[] }
        ).__readCoverageTexel?.(_corner)
      }, k.corner)
      expect(rgba, `${k.corner} texel present`).toBeTruthy()
      // Placeholder tolerance assertion — the harness compares against LUT(t) ±2.
      expect(rgba![3]).toBeGreaterThan(200) // opaque at a valid (non-nodata) cell
    }
  })

  test('the nodata hole renders fully transparent; the rim fades within ≤1 texel', async ({
    page,
  }) => {
    test.setTimeout(30_000)
    await page.goto('/demo.html?id=coverage_bathymetry&e2e=1', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 15_000 },
    )
    // Hole centre (grid ~row/col 16) → alpha ≈ 0 (w < 1/512 ⇒ discard, A3).
    const holeAlpha = await page.evaluate(() =>
      (
        window as unknown as { __readCoverageTexel?: (c: string) => number[] }
      ).__readCoverageTexel?.('HOLE_CENTER'),
    )
    expect(holeAlpha?.[3] ?? 255).toBeLessThan(8) // fully transparent
    // 16-split review + DC ladder (measured same-code noise floor) is run as the
    // whole-frame fidelity pass in the headed harness (compare-parity-pixeldiff).
  })
})
