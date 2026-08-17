// ═══ Coverage sounding numerals on the globe (#1435) — UNREGISTERED ═══
//
// Not wired into .github/workflows/test.yml (in-flight PRs contend that file — see the
// issue). Modeled on `_coverage-render.spec.ts` (same `coverage_bathymetry` fixture, same
// arcgisonline.com network block so the imagery basemap can't paint white pixels of its
// own) and `_bg-pattern-globe-gate.spec.ts` (the `proj=globe` URL override + invalidate-pump
// convergence loop for a globe camera).
//
// Pre-fix: `coverageSoundingAnchors`' visible-range probe ran through
// `Camera.unprojectToLonLat`, which returns null unconditionally once `globeMode` is set
// (map/src/camera/unproject.ts `relToLonLat`) — every probe missed, the walk returned `[]`,
// and the `soundings` layer's numerals never drew on the globe. Fix: `soundingUnprojector`
// (map/src/render/passes/dispatch-coverage-soundings.ts) forks to the ray↔sphere authority
// (`unprojectGlobeFromCamera`) in globe mode, the same fork the pointer path already takes.
//
// This gate gives that fix its FRAME-level witness: numeral (white-fill, black-halo,
// `label-color-#fff label-halo-color-#000` in coverage-bathymetry.xgis) pixel count on the
// globe, 0 before → nonzero after — the same "did it rasterise at all" existence check
// `_bg-pattern-globe-gate.spec.ts` uses for the analogous #1128 bug, not a structural claim.

import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

async function pump(page: Page): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await page.evaluate(() =>
      (window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.(),
    )
    await page.waitForTimeout(80)
  }
}

/** Count near-white pixels — the numeral fill colour (`label-color-#fff`). The imagery
 *  basemap is network-blocked (below) and the bathymetry ramp tops out well short of white,
 *  so a decisive near-white count is specific to rendered glyph coverage, not the backdrop. */
function countWhite(png: PNG): number {
  let n = 0
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i]!,
      g = png.data[i + 1]!,
      b = png.data[i + 2]!
    if (r > 230 && g > 230 && b > 230) n++
  }
  return n
}

test.describe('coverage sounding numerals on globe/tilted-azimuthal projections (#1435)', () => {
  test('numeral pixels: 0 on the (pre-fix) globe camera reproduction, nonzero after soundingUnprojector', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    await page.setViewportSize({ width: 900, height: 700 })
    await page.route(/arcgisonline\.com/, (r) => void r.abort())

    // Flat (mercator) control: numerals draw here BEFORE this fix too — proves the fixture
    // and the white-pixel metric both work, so a 0 count on the globe boot below is a real
    // regression signal rather than a broken harness.
    await page.goto('/demo.html?id=coverage_bathymetry&forcegl2=1&e2e=1#4.6/54/4', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      { timeout: 30_000 },
    )
    await pump(page)
    const flatPng = PNG.sync.read(await page.locator('#xg-canv, canvas').first().screenshot())
    const flatWhite = countWhite(flatPng)
    console.log(`[coverage-sounding-globe] flat white=${flatWhite}`)
    expect(flatWhite, 'control: numerals draw on the flat camera').toBeGreaterThan(50)

    // Globe boot — the reproduction. Same fixture, `proj=globe` forces `camera.globeMode`.
    await page.goto('/demo.html?id=coverage_bathymetry&forcegl2=1&proj=globe&e2e=1#4.6/54/4', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      { timeout: 30_000 },
    )
    await page.waitForFunction(
      () =>
        (window as unknown as { __xgisMap?: { camera?: { globeMode?: boolean } } }).__xgisMap
          ?.camera?.globeMode === true,
      { timeout: 10_000 },
    )
    await pump(page)
    const globePng = PNG.sync.read(await page.locator('#xg-canv, canvas').first().screenshot())
    const globeWhite = countWhite(globePng)
    console.log(`[coverage-sounding-globe] globe white=${globeWhite}`)

    // THE #1435 CLAIM: post-fix, the globe camera prints numerals too. A regression back to
    // the bare `unprojectToLonLat` closure reproduces the bug as globeWhite === 0.
    expect(globeWhite, 'numerals draw on the globe camera').toBeGreaterThan(50)
  })
})
