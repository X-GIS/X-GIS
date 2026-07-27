// ═══ S-100 coverage colour-ramp render (#1158 INC-A gate 3) ═══
//
// This spec was `test.fixme()`'d with the reason "no real GPU here; gate 3 is headed-only",
// and its assertions called a `__readCoverageTexel` harness that was never written. Both are
// gone: WebGL2 renders in this environment under SwiftShader (it is what CI's render-gate leg
// drives — only WebGPU has no software adapter), and `map.project()` is all the harness the
// readback actually needed.
//
// Fixture facts are MEASURED from playground/public/data/synthetic-bathymetry.h5, not copied
// from a comment (the old header claimed a -9999 fill; the file uses 1e6):
//   32×32 grid, origin (0.0, 50.0), spacing 0.25° ⇒ lon [-0.125, 7.875], lat [49.875, 57.875]
//   depth 0 m at the NORTH edge → 40 m at the SOUTH edge; corners NW=5 NE=15 SW=25 SE=35
//   nodata (1e6) fills rows/cols 13-18 — a 6×6 hole centred near (3.75, 53.75)
//
// The two claims are STRUCTURAL, because a painted-pixel count passes on broken images (§12):
// the nodata hole must not paint while its neighbours do, and the ramp must actually be keyed
// to the DATA — a flat fill or a dead LUT makes the deep south and the shallow north the same
// colour, and that is exactly what the difference assertion forbids.

import { test, expect } from '@playwright/test'

const HOLE: [number, number] = [3.75, 53.75] // nodata, grid rows/cols 13-18
const NEAR: [number, number] = [3.75, 52.6] // same longitude, just south of the hole
const SOUTH: [number, number] = [3.75, 50.5] // deep end of the ramp (~40 m)
const NORTH: [number, number] = [3.75, 57.2] // shallow end (~0 m)

/** Runs IN THE PAGE: reads the rendered RGBA under each lon/lat via `project()` + a 1×1
 *  `readPixels`. Yields null for an off-screen point, so a mis-framed camera fails loudly
 *  instead of sampling background and calling it transparent. */
function sample(points: [number, number][]) {
  const m = (
    window as unknown as {
      __xgisMap?: {
        ctx?: { rhi?: { gl?: WebGL2RenderingContext } }
        project(ll: readonly [number, number]): [number, number] | null
      }
    }
  ).__xgisMap
  const gl = m?.ctx?.rhi?.gl
  if (!gl) return points.map(() => null)
  const canvas = gl.canvas as HTMLCanvasElement
  const dpr = gl.drawingBufferWidth / canvas.clientWidth
  return points.map((p) => {
    const css = m!.project(p)
    if (!css) return null
    const x = Math.round(css[0] * dpr)
    // project() is top-left origin in CSS px; readPixels is bottom-up in device px.
    const y = Math.round(gl.drawingBufferHeight - css[1] * dpr)
    if (x < 0 || y < 0 || x >= gl.drawingBufferWidth || y >= gl.drawingBufferHeight) return null
    const px = new Uint8Array(4)
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    return { x, y, rgba: [px[0]!, px[1]!, px[2]!, px[3]!] as [number, number, number, number] }
  })
}

const lum = (c: readonly number[]) => c[0]! + c[1]! + c[2]!
const dist = (a: readonly number[], b: readonly number[]) =>
  Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!)

test.describe('S-100 coverage colour-ramp render (#1158)', () => {
  test('the ramp is keyed to the data and the nodata hole stays unpainted', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 900, height: 700 })
    await page.goto('/demo.html?id=coverage_bathymetry&forcegl2=1&e2e=1#5/53.875/3.875', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      { timeout: 20000 },
    )
    await page.waitForFunction(
      () =>
        (
          window as unknown as { __xgisMap?: { getCoverage(id: string): unknown } }
        ).__xgisMap?.getCoverage('bathy') != null,
      { timeout: 20000 },
    )
    await page.waitForTimeout(1200)

    const backend = await page.evaluate(
      () =>
        (window as unknown as { __xgisMap?: { ctx?: { rhi?: { backend?: string } } } }).__xgisMap
          ?.ctx?.rhi?.backend,
    )
    expect(backend, 'running on the WebGL2 backend').toBe('webgl2')
    await page.screenshot({ path: 'test-results/coverage-bathymetry.png' })

    const [hole, near, south, north] = await page.evaluate(sample, [HOLE, NEAR, SOUTH, NORTH])
    console.log('[coverage-render]', JSON.stringify({ hole, near, south, north }))

    expect(hole, 'hole sample on-screen').not.toBeNull()
    expect(near, 'valid-cell sample on-screen').not.toBeNull()
    expect(south, 'south sample on-screen').not.toBeNull()
    expect(north, 'north sample on-screen').not.toBeNull()

    // THE NODATA CLAIM: the hole must read markedly darker (unpainted) than a valid cell at
    // the same longitude. Relative, not an absolute threshold — the layer composites at 75%
    // over whatever the basemap resolved to.
    expect(lum(near!.rgba), 'a valid cell is painted').toBeGreaterThan(lum(hole!.rgba) + 30)

    // THE RAMP CLAIM: deep south (~40 m) and shallow north (~0 m) sit at opposite ends of the
    // bathymetry LUT. A flat fill or a dead LUT collapses this difference to ~0.
    expect(dist(south!.rgba, north!.rgba), 'the ramp varies with depth').toBeGreaterThan(40)
  })
})
