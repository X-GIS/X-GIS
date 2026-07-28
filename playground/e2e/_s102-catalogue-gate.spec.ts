// ═══ S-102 Live pans, because NOAA's own catalogue resolves the viewport (#1453) ═══
//
// This demo used to hard-code ONE cell key. Off Chesapeake Bay it drew nothing, and unlike
// S-111 it never even had the app-side mosaic that could have loaded a neighbour — the
// capability did not exist to be used.
//
// Its source now names `/noaa-s102/catalog.json`: NOAA's `_CATALOG/CATALOG.XML` (an IHO S-100
// Exchange Catalogue, 4313 published cells) translated to STAC by the proxy, with the engine
// resolving the viewport against it. So this gate is about the thing that was impossible
// before — moving the camera to a DIFFERENT survey and having bathymetry appear.
//
// Two properties make the assertions mean something:
//
//  1. Region keys are S-100 CELL NAMES (`102US004…`), never `__default__`. A hard-coded single
//     cell arms the default key; only the catalogue path arms a cell name.
//  2. Two viewports a state apart resolve to DIFFERENT cells, and both paint. One viewport
//     could pass with a single hard-coded cell; two cannot.
//
// S-102 cells are PROJECTED (UTM), so this also exercises the reprojected drape (#1366) on a
// cell chosen by the engine rather than named by hand.
//
// Needs NOAA egress through the proxy; skips loudly without it rather than passing vacuously.

import { test, expect } from '@playwright/test'

/** Two surveys far enough apart that no single cell can cover both. */
const CHESAPEAKE = { lon: -75.75, lat: 37.95, zoom: 10.5 }
const WILMINGTON = { lon: -77.85, lat: 33.45, zoom: 10.5 }

interface Probe {
  ok: boolean
  backend?: string
  regions?: string[]
  painted?: number
}

function probe(): Probe {
  const w = window as unknown as {
    __xgisMap?: {
      ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } }
      coverageRenderer?: { residentRegions(): string[] }
    }
  }
  const m = w.__xgisMap
  const gl = m?.ctx?.rhi?.gl
  if (!gl) return { ok: false }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  const buf = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  let painted = 0
  for (let i = 0; i < W * H; i++) {
    const o = i * 4
    if (buf[o]! + buf[o + 1]! + buf[o + 2]! > 24) painted++
  }
  return {
    ok: true,
    backend: m?.ctx?.rhi?.backend,
    regions: m?.coverageRenderer?.residentRegions() ?? [],
    painted: painted / (W * H),
  }
}

async function boot(page: import('@playwright/test').Page, at: typeof CHESAPEAKE) {
  await page.setViewportSize({ width: 900, height: 700 })
  // Block the basemap: imagery paints every pixel, so a painted-fraction including it would
  // read ~1.0 whatever the bathymetry did. The claim is about the COVERAGE.
  await page.route(/arcgisonline\.com/, (r) => void r.abort())
  await page.goto(`/demo.html?id=s102_live&forcegl2=1&e2e=1#${at.zoom}/${at.lat}/${at.lon}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )
}

/** Two phases, so a leg without egress gives up in ~60 s instead of sitting out a settle
 *  deadline it can never meet. The first read of the catalogue pulls 19 MB through the proxy
 *  and translates it, so the first-arrival budget is looser than S-111's. */
async function waitForResidency(page: import('@playwright/test').Page): Promise<boolean> {
  const regions = (): Promise<string[]> =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __xgisMap?: { coverageRenderer?: { residentRegions(): string[] } }
          }
        ).__xgisMap?.coverageRenderer?.residentRegions() ?? [],
    )
  const firstBy = Date.now() + 60_000
  while (Date.now() < firstBy) {
    await page.waitForTimeout(1000)
    if ((await regions()).length > 0) break
  }
  if ((await regions()).length === 0) return false

  const settleBy = Date.now() + 120_000
  let prev = ''
  while (Date.now() < settleBy) {
    const now = JSON.stringify(await regions())
    if (now !== '[]' && now === prev) return true
    prev = now
    await page.waitForTimeout(1000)
  }
  return false
}

test.describe('S-102 live: NOAA’s exchange catalogue resolves the viewport (#1453)', () => {
  test('two surveys a state apart each resolve to their own cell and paint', async ({ page }) => {
    test.setTimeout(300_000)

    await boot(page, CHESAPEAKE)
    if (!(await waitForResidency(page))) {
      test.skip(true, 'no NOAA egress — no cell arrived, so nothing is proven')
      return
    }
    const bay = await page.evaluate(probe)
    expect(bay.ok, 'WebGL2 context present').toBe(true)
    expect(bay.backend, 'running on the WebGL2 backend').toBe('webgl2')
    await page.screenshot({ path: 'test-results/s102-catalogue-chesapeake.png' })

    expect(bay.regions, 'the catalogue armed a cell').not.toHaveLength(0)
    expect(bay.regions, 'a cell NAME, not the single-cell default key').not.toContain('__default__')
    // S-100 cell names for this product all begin `102US` — a hard-coded key could not
    // produce a *different* one at the second viewport below, which is the real claim.
    for (const r of bay.regions!) expect(r).toMatch(/^102US/)
    expect(bay.painted, 'bathymetry actually painted').toBeGreaterThan(0.01)

    // ── A different survey entirely. Impossible before #1453: this demo had no machinery
    //    to load a second cell, so panning here simply showed nothing. ──
    await boot(page, WILMINGTON)
    if (!(await waitForResidency(page))) {
      test.skip(true, 'no NOAA egress for the second survey')
      return
    }
    const wilm = await page.evaluate(probe)
    await page.screenshot({ path: 'test-results/s102-catalogue-wilmington.png' })

    console.log(
      `[s102-catalogue] chesapeake regions=${JSON.stringify(bay.regions)} ` +
        `painted=${bay.painted?.toFixed(4)} | wilmington regions=${JSON.stringify(wilm.regions)} ` +
        `painted=${wilm.painted?.toFixed(4)}`,
    )

    for (const r of wilm.regions!) expect(r).toMatch(/^102US/)
    expect(wilm.painted, 'the second survey painted too').toBeGreaterThan(0.01)
    // THE GATE: different viewport ⇒ different cells. Equal sets would mean the camera is not
    // driving residency at all.
    expect(new Set(wilm.regions), 'a different survey resolves to different cells').not.toEqual(
      new Set(bay.regions),
    )
  })
})
