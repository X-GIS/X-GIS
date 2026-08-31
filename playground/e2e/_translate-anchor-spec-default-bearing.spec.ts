// #2170 — `*-translate-anchor`'s spec default is `map`, and this gate is the
// RENDER half of the proof.
//
// WHY THE CAMERA IS THE WHOLE POINT. A map-anchored and a viewport-anchored
// offset are the SAME vector at bearing 0 — rotateTranslateForAnchor
// (vector-tile-renderer.ts) is the identity there. So a north-up frame cannot
// distinguish the two anchors, and any gate built on one is vacuous BY
// CONSTRUCTION. This spec therefore puts the discriminating arm at a NONZERO
// bearing and keeps the bearing-0 case as the negative control that proves the
// bearing is what separates them.
//
// Two styles, identical but for the anchor:
//   A  fill-translate, NO anchor          → spec default map → world-space
//   B  fill-translate, anchor "viewport"  → screen-space
//
//   bearing 40 : A and B MUST DIFFER  (A rotates the offset, B does not)
//   bearing  0 : A and B MUST MATCH   (rotation is identity — the control)
//
// Fail-before: with the pre-#2170 converter A emitted no anchor utility and was
// byte-identical to B, so the bearing-40 arm went red with a ZERO diff while
// the bearing-0 control stayed green — i.e. the pair localises the bug rather
// than merely detecting a change.
//
// Offline by construction: the COMMITTED demotiles mirror
// (playground/public/vendor/demotiles-mirror, z0-2 real MVT tiles) served by
// the dev server. No network — headless Chromium in this container cannot
// reach the public internet. The mirror only has z0-2, so the camera stays in
// the low-zoom band; small viewport + msaa=1 keeps SwiftShader raster bounded.

import { test, expect, type Page } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node, so
// the @xgis/* workspace alias does not resolve here — specs import package
// SOURCES relatively (see _bundle-pixel-invariant.spec.ts).
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { captureMapFrame, awaitMapIdle } from './helpers/visual'
import { PNG } from 'pngjs'

test.describe.configure({ timeout: 300_000 })

// A large CSS-px offset so the rotation is unambiguous in pixels: at bearing 40
// a [60, 0] offset becomes ~[46, 39], i.e. ~39px off the screen-space arm's
// position — far above any SwiftShader raster noise floor.
const TRANSLATE: readonly [number, number] = [60, 0]

// Both arms must run the SAME backend or the diff is between two rasterizers,
// not between two anchors. Asserted per arm (§5) so a silent fallback cannot
// green this gate. The page carries no `?forcegl2`, so this is the WebGPU path
// on SwiftShader.
const EXPECTED_BACKEND = 'webgpu'

function style(anchor: 'absent' | 'viewport'): string {
  return convertMapboxStyle({
    version: 8,
    name: `anchor-${anchor}`,
    sources: {
      // Point at the mirror's real TileJSON MANIFEST, not the {z}/{x}/{y}
      // template: convertMapboxStyle lowers a Mapbox `tiles` array to
      // `type: tilejson, url: <first template>`, and the runtime then fetches
      // that template as a manifest (URL-encoding the braces) and gets the dev
      // server's HTML fallback. Both arms then render EMPTY and diff to 0 —
      // a vacuous run in which even the bearing-0 control passes for the wrong
      // reason. Measured, first run of this spec.
      maplibre: { type: 'vector', url: '/vendor/demotiles-mirror/tiles/tiles.json' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },
      {
        id: 'shifted',
        type: 'fill',
        source: 'maplibre',
        'source-layer': 'countries',
        paint: {
          'fill-color': '#101010',
          'fill-translate': TRANSLATE as unknown as number[],
          ...(anchor === 'viewport' ? { 'fill-translate-anchor': 'viewport' } : {}),
        },
      },
    ],
  } as never)
}

/** A FRESH CONTEXT per arm is load-bearing, not hygiene. Stacking two
 *  `addInitScript`s on one page does NOT apply them in registration order on
 *  the second navigation (documented in _bundle-replay-parity-gate.spec.ts,
 *  and measured here: both arms booted the FIRST style and rendered
 *  byte-identical frames — ink 112284 / 112284, diff 0). A per-arm context has
 *  exactly one init script, so the arm it boots is the arm it was given. */
async function capture(
  browser: import('@playwright/test').Browser,
  anchor: 'absent' | 'viewport',
  bearing: number,
): Promise<Buffer> {
  const src = style(anchor)
  const context = await browser.newContext({ viewport: { width: 640, height: 480 } })
  try {
    const page: Page = await context.newPage()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript((s: string) => {
      sessionStorage.setItem('__xgisImportSource', s)
      sessionStorage.setItem('__xgisImportLabel', 'anchor-2170')
    }, src)
    // `adaptive=0` is load-bearing (§12): the adaptive quality controller reads
    // MEASURED frame intervals and can move the tile SELECTOR, making the frame
    // a function of wall-clock — which a pixel comparison cannot absorb.
    await page.goto(`/demo.html?id=__import&e2e=1&msaa=1&adaptive=0#1.5/20/140/${bearing}/0`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 240_000 },
    )
    // The arm actually booted is the arm we asked for — never infer it.
    const booted = await page.evaluate(() => sessionStorage.getItem('__xgisImportSource') ?? '')
    expect(booted, `the ${anchor} arm must boot its own style`).toBe(src)
    // Name the backend so a silent fallback cannot green this gate (§5). Both
    // arms must be on the SAME one, or the pixel comparison is between two
    // rasterizers rather than between two anchors.
    const backend = await page.evaluate(
      () =>
        (window as unknown as { __xgisActiveBackend?: string | null }).__xgisActiveBackend ?? null,
    )
    expect(backend, `the ${anchor} arm's backend`).toBe(EXPECTED_BACKEND)
    await awaitMapIdle(page, 120_000)
    return await captureMapFrame(page)
  } finally {
    await context.close()
  }
}

/** Pixels that are not the white background — the PREMISE guard. An empty
 *  scene diffs to 0 against anything, which would let BOTH arms below pass or
 *  fail for a reason that has nothing to do with the anchor (measured: the
 *  first run of this spec pointed the source at a {z}/{x}/{y} template, the
 *  TileJSON attach failed, and two blank frames diffed to 0). */
function inkCount(buf: Buffer): number {
  const p = PNG.sync.read(buf)
  let n = 0
  for (let i = 0; i < p.data.length; i += 4) {
    if (p.data[i]! < 200 || p.data[i + 1]! < 200 || p.data[i + 2]! < 200) n++
  }
  return n
}

/** Pixels differing by more than a per-channel bit-noise tolerance. */
function diffCount(a: Buffer, b: Buffer): number {
  const pa = PNG.sync.read(a)
  const pb = PNG.sync.read(b)
  expect(pa.width, 'frame widths must match').toBe(pb.width)
  expect(pa.height, 'frame heights must match').toBe(pb.height)
  let n = 0
  for (let i = 0; i < pa.data.length; i += 4) {
    if (
      Math.abs(pa.data[i]! - pb.data[i]!) > 8 ||
      Math.abs(pa.data[i + 1]! - pb.data[i + 1]!) > 8 ||
      Math.abs(pa.data[i + 2]! - pb.data[i + 2]!) > 8
    ) {
      n++
    }
  }
  return n
}

test.describe('#2170 translate-anchor spec default — bearing discriminates', () => {
  test('PREMISE — the two arms differ by exactly the anchor utility', () => {
    const absent = style('absent')
    const viewport = style('viewport')
    // Absent ⇒ spec default map ⇒ the marker. Explicit viewport ⇒ no marker.
    expect(absent).toContain('fill-translate-anchor-map')
    expect(viewport).not.toContain('fill-translate-anchor-map')
    // Both must actually carry the offset, or there is nothing to anchor.
    expect(absent).toContain('fill-translate-x-')
    expect(viewport).toContain('fill-translate-x-')
    // …and the marker is the ONLY difference between the two sources.
    expect(absent.replace(' fill-translate-anchor-map', '')).toBe(
      viewport.replace('anchor-viewport', 'anchor-absent'),
    )
  })

  test('bearing 40: absent anchor renders DIFFERENTLY from explicit viewport', async ({
    browser,
  }) => {
    const absent = await capture(browser, 'absent', 40)
    const viewport = await capture(browser, 'viewport', 40)
    const ink = [inkCount(absent), inkCount(viewport)]
    console.log(`[anchor-2170] bearing 40 ink: ${ink.join(' / ')}`)
    expect(Math.min(...ink), 'PREMISE: both frames must contain drawn geometry').toBeGreaterThan(
      20_000,
    )
    const n = diffCount(absent, viewport)
    console.log(`[anchor-2170] bearing 40 diff pixels: ${n}`)
    // The absent case is now map-anchored, so its offset rotates by 40° while
    // the explicit-viewport arm's stays screen-fixed.
    expect(
      n,
      'a map-anchored and a viewport-anchored offset must differ at bearing 40',
    ).toBeGreaterThan(2_000)
  })

  test('NEGATIVE CONTROL — bearing 0: the two anchors are indistinguishable', async ({
    browser,
  }) => {
    const absent = await capture(browser, 'absent', 0)
    const viewport = await capture(browser, 'viewport', 0)
    const ink = [inkCount(absent), inkCount(viewport)]
    console.log(`[anchor-2170] bearing 0 ink: ${ink.join(' / ')}`)
    expect(Math.min(...ink), 'PREMISE: both frames must contain drawn geometry').toBeGreaterThan(
      20_000,
    )
    const n = diffCount(absent, viewport)
    console.log(`[anchor-2170] bearing 0 diff pixels: ${n}`)
    // Rotation by 0° is the identity, so map-anchor and viewport-anchor produce
    // the SAME offset. This is why a north-up gate proves nothing — and it is
    // what makes the bearing-40 arm above non-vacuous.
    expect(n, 'at bearing 0 the anchors must be indistinguishable').toBeLessThan(500)
  })
})
