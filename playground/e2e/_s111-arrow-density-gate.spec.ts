// ═══ The advected arrow field thins on zoom-out — rendered (#1450 B) ═══
//
// The stride the CPU applies is decided ONCE at arm time, from the drawable cell count alone
// (`coverage-arrow-show.ts` `arrowStride`); nothing in it looks at the camera. Zoom out and the
// arrows pile into a few pixels. The advected VS now thins per instance from the SCREEN spacing
// of its own grid cells.
//
// WHAT THIS MEASURES, and why it is not a painted-fraction gate in disguise. Zooming out shrinks
// the domain's footprint, so the whole-frame painted fraction falls for a reason that has nothing
// to do with density. The metric here is therefore INK PER DOMAIN PIXEL: painted pixels divided
// by the domain's own footprint. Without thinning that ratio SATURATES on zoom-out — the glyphs
// keep their pixel size while the cells they mark converge, so they overlap until the footprint
// is solid. With thinning it stays roughly where it was, because that is the whole point.
//
// A RATIO ACROSS TWO ZOOMS, so nothing here is an absolute pixel threshold. The near zoom is its
// own control: the same build, the same fixture, the same camera centre.
//
// On WebGl2Device under headless SwiftShader — the same software rasteriser the CI render-gate
// leg drives.

import { test, expect } from '@playwright/test'

const CENTRE_LAT = 38.1
const CENTRE_LON = -76.19
/** NEAR is the LEVEL-0 RUNG — the zoom at which the drawn set is exactly the catalogue's one
 *  arrow per cell (cell spacing 36.4 px, inside the cull's [34, 68) target band; the derivation
 *  is spelled out in `_s111-advected-arrows-gate.spec.ts`). So the near arm is pinned to a known
 *  density rather than to an arbitrary camera, and the same frame is what that gate asserts
 *  parity against. FAR is three levels down, an 8× linear convergence of the cells. */
const ZOOM_NEAR = 10
const ZOOM_FAR = 7
/** DEEP is where the filling half is the only thing that can help: the fixture's cells are
 *  2.2 km across, so the canvas spans only a few of them and one arrow per cell is a handful of
 *  glyphs — the reported symptom exactly, and the reason it gets worse the closer you look.
 *
 *  MEASURED, both portrayals, same camera, painted pixels on a 480×700 canvas:
 *
 *    zoom   | arrow (one per cell)   | flow (seeded 8× finer)
 *    z11         2031                     7722
 *    z12          677                     7941
 *    z13          179                     8272
 *    z14            0                     1772
 *
 *  z13 rather than z14 because at z14 the catalogue field paints NOTHING AT ALL — not one cell
 *  centre falls inside the viewport — and a control of zero makes the ratio meaningless however
 *  emphatic it looks. z13 keeps a live control and still separates by 45×.
 *
 *  The advected field's OWN fall from z13 to z14 is the seeding depth expiring, exactly where it
 *  was designed to: the lattice is 8× finer per axis and the level-0 rung is z10, so z13 is the
 *  last zoom with a node to spare (`arrowLattice`). Past it the field thins again at the same
 *  4×-per-zoom rate the catalogue field does — which is the honest limit of finite seeding, not a
 *  bug, and is why the cap is stated in zooms. */
const ZOOM_DEEP = 13

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

/** Painted pixels, and the domain's own footprint — the bounding box of everything painted.
 *  Ink per domain pixel is the ratio, which is what density means on screen. */
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
    ink: footprint > 0 ? painted / footprint : 0,
    /** Painted fraction of the whole canvas. Comparable only between two frames at the SAME
     *  camera — which is exactly the comparison the fill claim makes, and where the footprint
     *  normalization above would instead divide out the thing being measured (a field of three
     *  arrows has a small bbox, so its ink per domain pixel is not small). */
    frame: painted / (W * H),
  }
}

async function boot(
  page: import('@playwright/test').Page,
  zoom: number,
  portrayal: '| arrow' | '| flow' = '| flow',
) {
  await page.setViewportSize({ width: 900, height: 700 })
  // The basemap would paint every pixel and make the footprint the whole frame — the claim is
  // about ARROWS. A regex, not a glob: the host is one path segment (#1272's spec pays for that).
  await page.route(/arcgisonline\.com/, (r) => void r.abort())
  // `adaptive=0` PINS THE RESOLUTION. The ladder steps DPR down under sustained load, and a
  // smaller backing store converges the cells exactly like a zoom-out would — which is the one
  // confound that could fake this result (#1419's gate records the same measurement).
  await page.goto(
    `/demo.html?id=s111_currents&forcegl2=1&e2e=1&adaptive=0#${zoom}/${CENTRE_LAT}/${CENTRE_LON}`,
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

test.describe('S-111 advected arrows — view-driven density (#1450 B)', () => {
  test('zooming out THINS the field instead of saturating it', async ({ page }) => {
    test.setTimeout(240_000)

    await boot(page, ZOOM_NEAR)
    const near = await page.evaluate(readInk)
    expect(near.ok, 'WebGL2 context present').toBe(true)
    if (!near.ok) return
    // Asserted, not assumed: a silent fallback to the other backend would green this on a path
    // CI never runs.
    expect(near.backend, 'running on the WebGL2 backend').toBe('webgl2')
    // The CANVAS, not the page: the demo's source editor fills most of the window, so a page
    // screenshot is mostly text and useless as evidence for a claim about pixels.
    await page.locator('canvas').first().screenshot({ path: 'test-results/s111-density-near.png' })

    await boot(page, ZOOM_FAR)
    const far = await page.evaluate(readInk)
    expect(far.ok).toBe(true)
    if (!far.ok) return
    await page.locator('canvas').first().screenshot({ path: 'test-results/s111-density-far.png' })

    console.log(
      `[s111-density] near z${ZOOM_NEAR} painted=${near.painted} footprint=${near.footprint} ` +
        `ink=${near.ink.toFixed(4)} | far z${ZOOM_FAR} painted=${far.painted} ` +
        `footprint=${far.footprint} ink=${far.ink.toFixed(4)} | far/near=${(
          far.ink / Math.max(near.ink, 1e-6)
        ).toFixed(3)}`,
    )

    // PRECONDITIONS, each failing first and naming its own reason rather than surfacing as an
    // inscrutable ratio.
    expect(near.painted, 'near: the field drew').toBeGreaterThan(500)
    expect(far.painted, 'far: the field drew').toBeGreaterThan(500)
    expect(
      far.footprint,
      'far: the domain must be SMALLER on screen — is the zoom reaching the camera?',
    ).toBeLessThan(near.footprint)

    // THE CLAIM. Un-culled, the far frame's glyphs overlap until the footprint is nearly solid;
    // culled, the ink per domain pixel barely moves. Measured over the whole sweep, both
    // directions, BEFORE the bound was chosen — the un-culled arm produced by handing the shader
    // no grid, which is the same switch the layout test pins as "do not thin":
    //
    //   zoom   culled   un-culled
    //   z11    0.0080     0.0082      ← the cull correctly does NOTHING this far in
    //   z10    0.0214     0.0216      ←   (both arms agree: the control is shared)
    //   z9     0.0227     0.0866
    //   z8     0.0234     0.3068
    //   z7     0.0323     0.8252      ← 83% of the domain is solid ink without thinning
    //
    // far/near at z7 vs z10: 1.51 culled against 38.2 un-culled. Bound at the GEOMETRIC MIDPOINT,
    // 7.6 — 5× either way, so a regression must give back most of the separation to pass. A
    // ratio, so no pixel count is being tuned.
    expect(
      far.ink / Math.max(near.ink, 1e-6),
      'the far frame saturated — the field is not thinning with the view (#1450 B)',
    ).toBeLessThan(7.6)
  })

  test('zooming IN fills BETWEEN the cells instead of running out of arrows', async ({ page }) => {
    test.setTimeout(240_000)

    // The other half of one rule, and the half no arm-time stride could ever reach: `arrowStride`
    // returns 1 below the ceiling and nothing in the codebase made a second arrow for one cell,
    // so the density had a hard ceiling at the GRID's resolution. Zooming in magnified the cells
    // without adding anything between them.
    //
    // THE CONTROL IS THE STATIC PORTRAYAL AT THE SAME CAMERA — one arrow per cell, by the
    // catalogue's own rule, which is exactly the density the advected path used to be stuck at.
    // Same fixture, same zoom, same centre, same glyph and same scale rule, so the only thing
    // that differs between the two frames is how many positions were seeded.
    await boot(page, ZOOM_DEEP, '| arrow')
    const cells = await page.evaluate(readInk)
    expect(cells.ok, 'WebGL2 context present').toBe(true)
    if (!cells.ok) return
    expect(cells.backend, 'running on the WebGL2 backend').toBe('webgl2')
    await page.locator('canvas').first().screenshot({ path: 'test-results/s111-fill-static.png' })

    await boot(page, ZOOM_DEEP, '| flow')
    const filled = await page.evaluate(readInk)
    if (!filled.ok) return
    await page.locator('canvas').first().screenshot({ path: 'test-results/s111-fill-advected.png' })

    console.log(
      `[s111-fill] z${ZOOM_DEEP} static painted=${cells.painted} frame=${cells.frame.toFixed(5)} | ` +
        `advected painted=${filled.painted} frame=${filled.frame.toFixed(5)} | ` +
        `ratio=${(filled.frame / Math.max(cells.frame, 1e-9)).toFixed(2)}`,
    )

    // PRECONDITIONS. The first is the symptom itself, asserted rather than assumed: at this zoom
    // one arrow per cell really is a nearly empty frame, so the claim below is not being made
    // against a control that was already dense.
    expect(cells.painted, 'static: the catalogue field drew at all').toBeGreaterThan(0)
    expect(
      cells.frame,
      'static: one arrow per cell is SPARSE this far in — the symptom this fixes',
    ).toBeLessThan(0.005)
    // Deliberately a bare "it rasterised" floor, not a density floor: the un-filled arm draws
    // 260 px, so a stricter precondition would fail FIRST and report "the field drew" for what
    // is really a density regression. A precondition that steals the claim's failure message is
    // a gate that cannot say what broke.
    expect(filled.painted, 'advected: the field drew').toBeGreaterThan(100)

    // THE CLAIM. Sub-cell seeding puts arrows between the cells, so the same camera carries a
    // field instead of a handful of glyphs. A RATIO against the static control, not a pixel
    // count: what is claimed is a direction.
    //
    // Bound at the GEOMETRIC MIDPOINT of the two arms, 8.2. The un-filled arm is not assumed —
    // it is MEASURED, by capping the subdivision level at 0 so the lattice is the cell grid
    // again: 179 static against 260 advected, ratio 1.45. (Not 1.00, because the advected field
    // also drifts, so it paints a little outside the cells it was seeded on — which is why the
    // control has to be measured rather than reasoned to.) 46.2 green against 1.45 red, 5.6×
    // either way.
    expect(
      filled.frame / Math.max(cells.frame, 1e-9),
      'the advected field is no denser than one arrow per cell — the filling half is not running',
    ).toBeGreaterThan(8.2)
  })
})
