// ═══ A data-driven fill paints its PER-FEATURE colours on WebGL2 (#1592) ═══
//
// `fill match(…)` computes its colour in a shader variant. Until #1592 the WebGL2/RHI backend
// compiled none — the fill Material hardcoded `emitPolygonWgsl(null, …)` and its bind group carried
// one uniform entry, so the only colour sink was a CPU-resolved RGBA that is null by construction
// for a data-driven fill, and the layer disappeared. This gate previously asserted that blank plus
// the warning that announced it (#1583). #1592 wired the variant Material + the per-tile feat_data
// buffer, so the blank is gone and THIS is the assertion that replaces it — exactly the rewrite
// #1583's own header asked for when the capability landed.
//
// THE CLAIM IS THREE DISTINCT COLOURS, NOT PAINTED PIXELS, and the difference is the whole point.
// `fixture_categorical` is three features with `match(.kind)` → red / emerald / blue. A painted-
// fraction check cannot tell that apart from ONE flat colour over all three — and one flat colour
// is precisely the plausible failure here (the variant silently falling back to the default-uniform
// shader paints every feature in the last-written `u.fill_color`). Measured whole-frame, the
// data-driven arm and the constant-fill twin paint the IDENTICAL fraction, 0.3588 each, so the
// scalar is provably blind to the thing under test. The histogram is not. See §12: "a pixel-COUNT
// render gate passes on broken images — assert STRUCTURE".
//
// THE TWIN IS STILL THE CONTROL, and now carries a second job. It is the same source, the same
// three polygons and the same layer with a CONSTANT fill, so it still rules out "the fixture, the
// source, the style or the harness is broken". But it is also the NEGATIVE case for the histogram
// itself: a constant fill must show exactly ONE dominant colour through the same measurement that
// reports three for the treatment. An assertion that reported "three" for both would be the
// 2026-07-28 "failed either way" shape.
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
function measure(png: Buffer): { painted: number; hues: { rgb: string; share: number }[] } {
  const img = PNG.sync.read(png)
  const x0 = Math.floor(img.width * 0.25)
  const x1 = Math.floor(img.width * 0.75)
  const y0 = Math.floor(img.height * 0.35)
  const y1 = Math.floor(img.height * 0.65)
  const area = (x1 - x0) * (y1 - y0)
  let painted = 0
  // Colours bucketed to 5 bits per channel. The quantisation absorbs the raster's
  // edge blend without merging the fixture's three authored hues, which are far
  // apart (#e94b4b / #10b880 / #3880f0) — a bucket wide enough to fuse THOSE would
  // also fuse red into blue, which no plausible bug produces.
  const hist = new Map<string, number>()
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4
      const r = img.data[i]!
      const g = img.data[i + 1]!
      const b = img.data[i + 2]!
      if (r <= 24 && g <= 24 && b <= 24) continue
      painted++
      const k = `${(r >> 3) << 3},${(g >> 3) << 3},${(b >> 3) << 3}`
      hist.set(k, (hist.get(k) ?? 0) + 1)
    }
  }
  // DOMINANT colours only (≥5% of the crop). Anti-aliased edge pixels form a long
  // tail of one-off buckets; counting those would report dozens of "colours" for a
  // flat fill and the assertion would pass on the very failure it exists to catch.
  const hues = [...hist.entries()]
    .map(([rgb, n]) => ({ rgb, share: n / area }))
    .filter((h) => h.share >= 0.05)
    .sort((a, b) => b.share - a.share)
  return { painted: painted / area, hues }
}

/** Render one fixture on the WebGL2 backend, collecting anything it logs.
 *
 *  `ptdur=0&fade=0&adaptive=0` is the documented pixel-gate idiom (demo-runner.ts): paint
 *  transitions and symbol fades off so a mid-fade capture cannot flake, and the quality ladder
 *  pinned so it cannot converge the frame differently between the two arms. */
async function renderFixture(
  page: import('@playwright/test').Page,
  id: string,
): Promise<{ painted: number; hues: { rgb: string; share: number }[]; warnings: string[] }> {
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
    return { ...measure(png), warnings }
  } finally {
    page.off('console', onConsole)
  }
}

test.describe('data-driven fill on WebGL2 (#1592)', () => {
  test('paints each feature its own match() colour', async ({ page }) => {
    test.setTimeout(180_000)

    // ── CONTROL: the same scene with a constant fill. Establishes that the source loads, the
    //    geometry tessellates, the backend rasterises and this harness can see pixels at all —
    //    AND that the histogram reports ONE colour when there genuinely is one. ──
    const twin = await renderFixture(page, 'fixture_categorical_twin')
    expect(
      twin.painted,
      'control: a CONSTANT fill must paint on WebGL2 — if this is blank the harness, the source ' +
        'or the fixture is broken and the rest of this gate proves nothing',
    ).toBeGreaterThan(0.1)

    // ── TREATMENT: identical scene, `fill match(.kind)`. ──
    const dataDriven = await renderFixture(page, 'fixture_categorical')

    console.log(
      `[fill-dd-gl2] twin painted=${twin.painted.toFixed(4)} hues=${twin.hues.length} ` +
        `[${twin.hues.map((h) => `${h.rgb}@${(h.share * 100).toFixed(1)}%`).join(' ')}] | ` +
        `dataDriven painted=${dataDriven.painted.toFixed(4)} hues=${dataDriven.hues.length} ` +
        `[${dataDriven.hues.map((h) => `${h.rgb}@${(h.share * 100).toFixed(1)}%`).join(' ')}]`,
    )

    // The layer must reach the screen at all. Kept ahead of the colour claim so a regression that
    // re-blanks the layer reports "it drew nothing", not the more confusing "it drew one colour".
    expect(
      dataDriven.painted,
      'the data-driven fill draws nothing on WebGL2 — #1592 has regressed',
    ).toBeGreaterThan(0.1)

    // THE CLAIM. Three features, three authored colours, three dominant hues. A variant that fell
    // back to the default-uniform shader would paint all three in one colour and land on 1 here —
    // which is exactly the state this gate replaced, and the reason the painted fraction alone
    // (identical for both arms) cannot be the assertion.
    expect(
      dataDriven.hues.length,
      'a data-driven fill must paint its features their OWN colours — one dominant hue means the ' +
        'variant is not reaching the fragment and every feature took the same uniform colour',
    ).toBe(3)
    // …and the negative case through the SAME measurement, so the assertion above is known to
    // distinguish the two states rather than reporting 3 for anything that paints.
    expect(
      twin.hues.length,
      'control: a CONSTANT fill must show exactly one dominant hue — if this also reports 3 the ' +
        'histogram is measuring the raster, not the fill',
    ).toBe(1)
    // Equal thirds: the three fixture polygons are the same size, so a variant that painted two
    // features correctly and collapsed the third would still report 3 hues but skew the shares.
    for (const h of dataDriven.hues) {
      expect(h.share, `hue ${h.rgb} covers roughly a third of the painted area`).toBeGreaterThan(
        twin.hues[0]!.share / 3 - 0.02,
      )
    }

    // Neither arm may warn now: the treatment is drawn, not skipped, so #1583's gap message must
    // not fire — and the control's null-fill guard never fired to begin with.
    expect(
      dataDriven.warnings.filter((w) => w.includes('data-driven fill')),
      'a fill this backend now draws must not report itself as an unsupported gap',
    ).toHaveLength(0)
    expect(
      twin.warnings.filter((w) => w.includes('data-driven fill')),
      'a constant fill must stay silent',
    ).toHaveLength(0)
  })
})
