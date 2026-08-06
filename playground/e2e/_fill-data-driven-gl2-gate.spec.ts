// ═══ A data-driven fill on WebGL2 renders blank — and SAYS SO (#1583) ═══
//
// `fill match(…)` / `fill gradient(…)` compute their colour in a shader variant. The WebGL2/RHI
// backend compiles none — `pipeline-factory.ts` returns before building any variant pipeline on
// webgl2, `POLYGON_FILL_FORMAT` carries no colour attribute, and the palette atlas is never
// uploaded there — so `renderFillsRhi` finds a null CPU colour and returns 0. The layer disappears.
// Shipped styles hit this: continent-match, income-match, gdp-gradient, population-gradient,
// coops-currents.
//
// THE BLANK IS NOT THE BUG, AND THIS GATE DOES NOT ASK FOR PIXELS. There is no colour on this
// backend to draw with, and painting one flat colour over a choropleth would misreport the data —
// worse than drawing nothing. The capability itself is #1592. What #1583 fixed is that the blank
// was SILENT: a user authoring `fill match(…)` got an empty layer and no explanation anywhere.
//
// SO THE ASSERTION IS THE WARNING, and the two pixel arms exist to make that assertion mean
// something. A blank frame on its own cannot distinguish "this backend has no per-feature fill
// path" from "the fixture, the source, the style or this harness is broken" — every one of those
// is also blank. The constant-fill twin (same source, same three polygons, same layer, constant
// colour) paints, which rules all of them out. Without that arm the blank assertion would pass on
// a completely broken playground, which is the §12 failure this repo keeps paying for.
//
// WHEN #1592 LANDS THIS GATE GOES RED, and that is correct — it is the signal that the limitation
// is gone. Replace the blank arm with a per-feature colour assertion then (fixture_categorical is
// already a discriminator: three features, match(.kind) → red/emerald/blue).
//
// WebGPU cannot be the control here: there is no software WebGPU adapter in this environment or on
// the CI render-gate leg (CLAUDE.md §5), which is why the control is a same-backend twin instead.

import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureCanvas } from './helpers/visual'

const ART = 'test-results/fill-data-driven-gl2'

/** Fraction of non-background pixels in the CENTRAL MAP REGION. Background is the demo's black
 *  canvas; the `>24` threshold matches the sibling fill gates rather than inventing a second
 *  convention.
 *
 *  THE CROP IS LOAD-BEARING, and the reason is almost funny: the demo page draws its own chrome —
 *  a hash badge, two buttons, a caption, and an ERRORS PANEL that pops open when anything warns.
 *  Measured whole-frame, the data-driven arm read 0.018 painted with a completely black map,
 *  because this gate's own warning had opened that panel. The gate would have been measuring its
 *  subject's side effect. The polygons land dead centre (verified against the twin capture), so
 *  the middle half by width and middle third by height contains all of them and none of the
 *  chrome. */
function paintedFraction(png: Buffer): number {
  const img = PNG.sync.read(png)
  const x0 = Math.floor(img.width * 0.25)
  const x1 = Math.floor(img.width * 0.75)
  const y0 = Math.floor(img.height * 0.35)
  const y1 = Math.floor(img.height * 0.65)
  let painted = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4
      if (img.data[i]! > 24 || img.data[i + 1]! > 24 || img.data[i + 2]! > 24) painted++
    }
  }
  return painted / ((x1 - x0) * (y1 - y0))
}

/** Render one fixture on the WebGL2 backend, collecting anything it logs.
 *
 *  `ptdur=0&fade=0&adaptive=0` is the documented pixel-gate idiom (demo-runner.ts): paint
 *  transitions and symbol fades off so a mid-fade capture cannot flake, and the quality ladder
 *  pinned so it cannot converge the frame differently between the two arms. */
async function renderFixture(
  page: import('@playwright/test').Page,
  id: string,
): Promise<{ painted: number; warnings: string[] }> {
  const warnings: string[] = []
  const onConsole = (m: import('@playwright/test').ConsoleMessage): void => {
    if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text())
  }
  // DETACHED in `finally`, and that is not tidiness. A left-attached listener keeps filling THIS
  // call's array during the NEXT fixture's render, so the control arm inherited the treatment
  // arm's warning and the "a constant fill stays silent" assertion failed against a silent fixture.
  page.on('console', onConsole)
  try {
    await page.goto(`/demo.html?id=${id}&backend=webgl2&e2e=1&ptdur=0&fade=0&adaptive=0`, {
      waitUntil: 'domcontentloaded',
    })
    // Asserted, not assumed: if the page silently fell back to WebGPU (or failed to boot a
    // context) this would be measuring a different backend than the one it makes claims about.
    await expect(page.locator('#backend-tag')).toHaveText('WebGL2', { timeout: 30_000 })
    const png = await captureCanvas(page, { readyTimeoutMs: 30_000 })
    mkdirSync(ART, { recursive: true })
    writeFileSync(join(ART, `${id}.png`), png)
    return { painted: paintedFraction(png), warnings }
  } finally {
    page.off('console', onConsole)
  }
}

test.describe('data-driven fill on WebGL2 (#1583)', () => {
  test('draws nothing, and warns by name that it drew nothing', async ({ page }) => {
    test.setTimeout(180_000)

    // ── CONTROL: the same scene with a constant fill. Establishes that the source loads, the
    //    geometry tessellates, the backend rasterises and this harness can see pixels at all. ──
    const twin = await renderFixture(page, 'fixture_categorical_twin')
    expect(
      twin.painted,
      'control: a CONSTANT fill must paint on WebGL2 — if this is blank the harness, the source ' +
        'or the fixture is broken and the rest of this gate proves nothing',
    ).toBeGreaterThan(0.1)

    // ── TREATMENT: identical scene, `fill match(.kind)`. ──
    const dataDriven = await renderFixture(page, 'fixture_categorical')

    const named = dataDriven.warnings.filter(
      (w) => w.includes('data-driven fill') && w.includes('cats') && w.includes('#1592'),
    )
    console.log(
      `[fill-dd-gl2] twin painted=${twin.painted.toFixed(4)} ` +
        `dataDriven painted=${dataDriven.painted.toFixed(4)} | warnings=${named.length} ` +
        `| first=${named[0] ?? '(none)'}`,
    )

    // THE CLAIM. The layer is named, the backend gap is named, and the tracking issue is named —
    // so the message is actionable rather than a bare "something did not draw".
    expect(
      named.length,
      'the gap must announce itself, naming the layer and pointing at #1592',
    ).toBeGreaterThan(0)
    // Recorded, not relied on: this static demo settles after a handful of frames, so it reaches
    // the bail about once either way — removing the latch does NOT turn this red (checked). The
    // latch's real gate is `rhi-data-driven-fill-warning.test.ts`, which drives 120 calls and does
    // distinguish 1 from 120. Kept because a sudden burst here would still be worth seeing.
    expect(named.length, 'not repeated within a settled frame').toBe(1)

    // Characterizing the limitation itself, so a future per-feature path cannot land unnoticed.
    expect(
      dataDriven.painted,
      'the data-driven fill still draws nothing on WebGL2 — if this now paints, #1592 landed and ' +
        'this gate should be rewritten to assert per-feature colours',
    ).toBeLessThan(0.005)

    // The control must NOT warn: its null-fill guard never fires, so a constant-fill style stays
    // quiet. This is what stops the message degrading into noise every layer emits.
    expect(
      twin.warnings.filter((w) => w.includes('data-driven fill')),
      'a constant fill must stay silent',
    ).toHaveLength(0)
  })
})
