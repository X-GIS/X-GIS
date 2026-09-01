// ═══ `import "<style.json>"` must forward the style's `glyphs` (#2121) ═══
//
// #1112 taught the live one-line import path to forward an imported style's
// top-level `sprite` and stopped one field short. On this path the raw style
// JSON is fetched INSIDE `resolveImportsAsync` and consumed by the converter,
// so the host never sees `style.glyphs` to call `setGlyphsUrl` itself, and the
// converter omits it from the emitted DSL by design.
//
// The result, measured on this exact demo before the fix:
//
//     [ladder] at-ready  {"glyphsUrl":null,"hasPbf":false}
//     [ladder] after-8s  {"glyphsUrl":null,"hasPbf":false}
//
// `glyphsUrl === null` sends `text/glyph-rasterizer-wiring.ts:49` down the
// plain-Canvas2D branch, `TextStage.pbfRasterizer` stays null, no
// `GlyphPbfCache` is ever constructed, and every style-import scene draws its
// labels in SYSTEM FONTS instead of the style's own SDF fontstack — silently.
//
// This fixture is the right subject because it is self-contained: the mirror's
// `style.json` sets `glyphs: /vendor/demotiles-mirror/font/{fontstack}/{range}.pbf`,
// both of its label layers author `Open Sans Semibold`, and that range is
// COMMITTED at `playground/public/vendor/demotiles-mirror/font/Open Sans
// Semibold/0-255.pbf`. Before the fix the repo paid those bytes and never
// requested them.
//
// The load-bearing assertion is the NETWORK one. `glyphsUrl !== null` alone
// would pass on a wire that reaches the field and stops there; the PBF request
// is the end of the chain, and it is the observation the issue's evidence
// turned on.

import { test, expect } from '@playwright/test'
import { captureMapFrame } from './helpers/visual'

const DEMO = '/demo.html?id=import_maplibre_mirror&e2e=1&adaptive=0#1.5/20/140'
/** The one range the mirror ships, for the one fontstack both label layers use. */
const PBF = /\/vendor\/demotiles-mirror\/font\/.*\/0-255\.pbf$/

test.describe.configure({ timeout: 180_000 })

test("the imported style's glyphs URL reaches the runtime AND its PBF range is fetched (#2121)", async ({
  page,
}) => {
  const pbfRequests: string[] = []
  page.on('request', (r) => {
    if (PBF.test(r.url())) pbfRequests.push(r.url())
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  await page.goto(DEMO, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 90_000 },
  )

  // captureMapFrame's settle waits on the pending-work registry, and `glyph` is
  // one of its kinds (map/src/pending-work.ts:37, :233-238) — so a frame is not
  // captured while a glyph range is still in flight. That is what makes the
  // request assertion below deterministic rather than a race.
  await captureMapFrame(page)

  // 1. The wire itself: the URL the converter collected reached the map.
  //    Fail-before: null.
  const glyphsUrl = await page.evaluate(
    () => (window as unknown as { __xgisMap?: { glyphsUrl?: string | null } }).__xgisMap?.glyphsUrl,
  )
  expect(
    glyphsUrl,
    'map.glyphsUrl is null — the imported style\'s top-level `glyphs` was dropped on the `import "url"` path (#2121)',
  ).toContain('{fontstack}')

  // 2. The chain the wire exists to build. `pbfRasterizer` is private on
  //    TextStage, and it is read here deliberately: it IS the object whose
  //    absence defines the defect (glyph-rasterizer-wiring.ts case 3), and no
  //    public accessor exposes which branch was taken.
  const hasPbf = await page.evaluate(() => {
    const ts = (window as unknown as { __xgisMap?: { textStage?: unknown } }).__xgisMap?.textStage
    return (
      ts !== null && ts !== undefined && (ts as { pbfRasterizer?: unknown }).pbfRasterizer != null
    )
  })
  expect(
    hasPbf,
    'TextStage has no pbfRasterizer — glyph-rasterizer-wiring took the plain-Canvas2D case, so labels draw in system fonts',
  ).toBe(true)

  // 3. The end of the chain, and the assertion a wiring-only fix cannot fake:
  //    the committed range is actually requested. Before #2121 this array was
  //    empty on every run of this demo.
  expect(
    pbfRequests.length,
    `no glyph PBF was requested; the committed range at vendor/demotiles-mirror/font/Open Sans Semibold/0-255.pbf stayed unread. Requests seen: ${JSON.stringify(pbfRequests)}`,
  ).toBeGreaterThan(0)

  expect(errors, 'no page errors').toEqual([])
})
