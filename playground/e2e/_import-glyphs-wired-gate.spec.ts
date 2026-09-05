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
import { awaitPendingWorkClear } from './helpers/visual'

const DEMO = '/demo.html?id=import_maplibre_mirror&e2e=1&adaptive=0#1.5/20/140'
/** Any glyph range request against the mirror — the population. */
const PBF = /\/vendor\/demotiles-mirror\/font\/(.*)\/0-255\.pbf$/
/** The fontstack BOTH label layers author (`text-font: ["Open Sans Semibold"]`),
 *  and the only range the mirror ships. Asserting the population alone is not
 *  enough: a request for some OTHER fontstack 404s, the dev server answers with
 *  an HTML error page, and `decodeGlyphsPbf` reports `unknown wire type 4`
 *  while this gate would still count "a request was made". */
const WANTED = 'Open Sans Semibold'

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
  const glyphWarnings: string[] = []
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('glyph range') && t.includes('failed to load'))
      glyphWarnings.push(t.slice(0, 200))
  })

  await page.goto(DEMO, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 90_000 },
  )

  // Settle on the pending-work registry, of which `glyph` is one kind
  // (map/src/pending-work.ts:37, :233-238) — so no assertion below runs while a
  // glyph range is still in flight. That is what makes the request assertion
  // deterministic rather than a race.
  //
  // This used to be `captureMapFrame(page)`, and BOTH halves of that were cost
  // this gate never spent on an assertion (#2366):
  //
  //   * the screenshot. Nothing here reads a pixel, and `page.screenshot` adds a
  //     fonts-load wait, a scroll-into-view stability wait and a PNG encode. It
  //     is also the step that hangs: the CI failures report `locator.screenshot:
  //     Test timeout` for a gate that asserts only on a URL, a field and a
  //     network request.
  //   * the UNSCOPED settle. `captureMapFrame` waits for EVERY pending-work kind
  //     to clear, and measured on this demo that never happens — `vt-upload` was
  //     still draining slice uploads at 125 s, so the settle always resolved by
  //     timing out rather than by converging. `glyph`, the only kind this spec
  //     depends on, clears in under 20 s. Scoping the wait to it turns a fixed
  //     budget-length wait into a real convergence.
  // #2370 — and PIN that it converged. The comment above claims this scoped
  // wait is a real convergence rather than a budget-length sleep; before
  // `awaitPendingWorkClear` reported its arm, that claim was unfalsifiable from
  // here, which is exactly how the unscoped version passed for a convergence
  // for as long as it did. Asserting 'clear' makes the difference observable:
  // widen the scope back to every kind and this reds with 'timeout'.
  const settleArm = await awaitPendingWorkClear(page, 60_000, ['glyph'])
  expect(settleArm, 'the glyph-scoped settle must CONVERGE, not time out').toBe('clear')

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
  const stacks = pbfRequests.map((u) => decodeURIComponent(u.match(PBF)![1]!))
  expect(
    stacks,
    `the committed range at vendor/demotiles-mirror/font/${WANTED}/0-255.pbf stayed unread. Fontstacks requested: ${JSON.stringify(stacks)}`,
  ).toContain(WANTED)

  // 4. And THAT range decoded. Scoped to the authored fontstack on purpose:
  //    this run also requests `Noto Sans CJK KR Regular`, which no glyph
  //    server ships and which 404s into `PbfReader: unknown wire type 4` on
  //    the dev server's HTML error page. That stray request is a SEPARATE
  //    defect (#2259) that #2121 only made visible — before the wire landed,
  //    no glyph range was requested at all, so nothing could 404. Asserting
  //    an empty warning list here would make this gate hostage to that bug;
  //    asserting it for OUR fontstack still reds if the Open Sans path breaks.
  const wantedWarnings = glyphWarnings.filter((w) => w.includes(WANTED))
  expect(
    wantedWarnings,
    `${WANTED} was fetched but not decoded, so the style's labels are still system fonts: ${JSON.stringify(wantedWarnings)}`,
  ).toEqual([])

  expect(errors, 'no page errors').toEqual([])
})
