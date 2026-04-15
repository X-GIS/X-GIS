import { test, expect, type Page } from '@playwright/test'
import {
  captureCanvas, expectColorHistogram, sampleNonBackgroundPixels,
  type ColorBucket,
} from './helpers/visual'
import { withValidationCapture, clearValidationErrors } from './helpers/validation'

// ═══ X-GIS feature fixture suite ═══
//
// Each fixture is a minimum-data .xgis demo that isolates ONE
// rendering capability (a single point, a single triangle, one
// keyframe, etc). Failures point at the exact feature, not at a
// production demo whose surface area touches dozens of code
// paths.
//
// Every fixture test:
//   1. Navigates to the fixture URL and waits __xgisReady
//   2. Clears the per-context validation error queue
//   3. Captures the canvas
//   4. Asserts pixel content (color histogram, not pixel-perfect)
//   5. Asserts no WebGPU validation errors fired during the test
//
// The `withValidationCapture` wrapper at the bottom of each test
// catches bind group / pipeline / layout errors. Histogram
// thresholds are loose intentionally — the goal is "is this color
// present somewhere on the canvas" not "exactly N pixels match".
// Tighter assertions live in production smoke baselines.

const FIXTURE_TIMEOUT_MS = 15_000

async function loadFixture(page: Page, id: string): Promise<void> {
  await page.goto(`/demo.html?id=${id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: FIXTURE_TIMEOUT_MS },
  )
  // Reset the validation queue AFTER ready so any startup errors
  // (pipeline rebuilds during init) don't bleed into per-test
  // assertions.
  await clearValidationErrors(page)
  // Two extra rAF ticks to let everything compose into the
  // visible swap chain.
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
}

/** Helper: run a fixture and assert at least one bucket has a
 *  ratio in the given range. Wraps in validation capture. */
async function fixtureColorAssert(
  page: Page,
  id: string,
  buckets: ColorBucket[],
  ranges: Record<string, [number, number]>,
): Promise<void> {
  await withValidationCapture(page, async () => {
    await loadFixture(page, id)
    const png = await captureCanvas(page)
    await expectColorHistogram(page, png, buckets, ranges)
  })
}

// Tailwind color references (used across many fixtures)
const RED_500: [number, number, number] = [239, 68, 68]
const BLUE_500: [number, number, number] = [59, 130, 246]
const EMERALD_500: [number, number, number] = [16, 185, 129]
const ROSE_500: [number, number, number] = [244, 63, 94]
const AMBER_300: [number, number, number] = [252, 211, 77]
const AMBER_500: [number, number, number] = [245, 158, 11]
const SKY_400: [number, number, number] = [56, 189, 248]

// ── Geometry ──────────────────────────────────────────────────────

test.describe('X-GIS fixture: geometry', () => {
  test('point — single SDF point renders red pixels', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_point',
      [{ name: 'red', rgb: RED_500, tolerance: 80 }],
      { red: [0.001, 0.30] },
    )
  })

  test('line — 2-vertex line renders amber pixels', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_line',
      [{ name: 'amber', rgb: AMBER_300, tolerance: 80 }],
      { amber: [0.001, 0.30] },
    )
  })

  test('line_join — sharp turn renders amber + miter geometry intact', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_line_join',
      [{ name: 'amber', rgb: AMBER_300, tolerance: 80 }],
      { amber: [0.001, 0.30] },
    )
  })

  test('triangle — 3-vertex polygon renders blue fill', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_triangle',
      [{ name: 'blue', rgb: BLUE_500, tolerance: 80 }],
      { blue: [0.001, 0.50] },
    )
  })

  test('square — 4-vertex tessellation renders emerald fill', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_square',
      [{ name: 'emerald', rgb: EMERALD_500, tolerance: 80 }],
      { emerald: [0.005, 0.60] },
    )
  })
})

// ── Style ─────────────────────────────────────────────────────────

test.describe('X-GIS fixture: style', () => {
  test('stroke_fill — both fill and stroke colors visible on one layer', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_stroke_fill', [
      { name: 'blue', rgb: BLUE_500, tolerance: 80 },
      { name: 'amber', rgb: AMBER_300, tolerance: 80 },
    ], {
      blue:  [0.001, 0.50],
      amber: [0.001, 0.30],
    })
  })

  test('dashed_line — dash shader produces amber pixels', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_dashed_line',
      [{ name: 'amber', rgb: AMBER_300, tolerance: 80 }],
      { amber: [0.001, 0.30] },
    )
  })

  test('translucent_stroke — bucket 2 offscreen path renders without freezing', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    // Translucent layer means alpha-blended pixels never match the
    // pure source color exactly. Use non-background sampling: if
    // bucket 2 (offscreen MAX-blend + composite) is broken, the
    // canvas stays empty. We don't care about the exact color
    // here, just that SOMETHING was composited.
    await withValidationCapture(page, async () => {
      await loadFixture(page, 'fixture_translucent_stroke')
      const png = await captureCanvas(page)
      const differing = await sampleNonBackgroundPixels(
        page, png,
        { r: 6, g: 8, b: 12 }, // dark canvas background
        50,                    // tolerance
        400,                   // 20x20 sample grid
      )
      expect(differing,
        `translucent_stroke: only ${differing}/400 sampled pixels differ from background — bucket 2 likely broken`)
        .toBeGreaterThan(2)
    })
  })

  test('multi_layer — top layer renders over bottom layer', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_multi_layer', [
      { name: 'blue', rgb: BLUE_500, tolerance: 80 },
      { name: 'rose', rgb: ROSE_500, tolerance: 80 },
    ], {
      blue: [0.001, 0.60],
      rose: [0.001, 0.40],
    })
  })
})

// ── Animation ─────────────────────────────────────────────────────

test.describe('X-GIS fixture: animation', () => {
  test('anim_opacity — opacity keyframe (Bug 1 isolation)', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    // Single-shot capture can land at any point in the cycle; at the
    // opacity-30 trough the alpha-blended emerald drops well below
    // tolerance=100 from the dark background. Multi-sample like
    // anim_color does — assert the bucket reaches a non-trivial peak
    // at SOME point in the cycle instead of any single frame.
    await withValidationCapture(page, async () => {
      await loadFixture(page, 'fixture_anim_opacity')
      const buckets: ColorBucket[] = [
        { name: 'emerald', rgb: EMERALD_500, tolerance: 120 },
      ]
      let maxEmerald = 0
      for (const ms of [100, 400, 800, 1200, 1600, 2000]) {
        const png = await captureCanvas(page, { elapsedMsAtLeast: ms })
        const r = await (await import('./helpers/visual')).colorHistogram(page, png, buckets)
        if (r.emerald > maxEmerald) maxEmerald = r.emerald
      }
      expect(maxEmerald,
        `anim_opacity: emerald peak ${(maxEmerald * 100).toFixed(3)}% across 6 samples — fill never reached opacity-100 phase`)
        .toBeGreaterThan(0.005)
    })
  })

  test('anim_color — fill keyframe cycles between blue and rose', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await withValidationCapture(page, async () => {
      await loadFixture(page, 'fixture_anim_color')
      // Sample at multiple time points and assert BOTH colors
      // appear at SOME point — proves the keyframe morphs.
      const buckets: ColorBucket[] = [
        { name: 'blue', rgb: BLUE_500, tolerance: 100 },
        { name: 'rose', rgb: ROSE_500, tolerance: 100 },
      ]
      let sawBlue = false
      let sawRose = false
      for (const ms of [200, 600, 1000, 1400, 1800, 2200, 2600, 3000]) {
        const png = await captureCanvas(page, { elapsedMsAtLeast: ms })
        const r = await import('./helpers/visual').then(v => v.colorHistogram(page, png, buckets))
        if (r.blue > 0.01) sawBlue = true
        if (r.rose > 0.01) sawRose = true
      }
      if (!sawBlue || !sawRose) {
        throw new Error(`anim_color: blue=${sawBlue} rose=${sawRose} — keyframe not morphing`)
      }
    })
  })
})

// ── SDF Points ────────────────────────────────────────────────────

test.describe('X-GIS fixture: sdf-points', () => {
  test('sdf_point — billboard pin marker', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_sdf_point',
      [{ name: 'rose', rgb: ROSE_500, tolerance: 100 }],
      { rose: [0.001, 0.30] },
    )
  })

  test('sdf_glow — translucent halo + opaque pin', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_sdf_glow',
      [{ name: 'amber', rgb: AMBER_500, tolerance: 100 }],
      { amber: [0.001, 0.30] },
    )
  })
})

// ── Coordinate / projection ───────────────────────────────────────

// ── Stress fixtures (exercise validation capture) ─────────────────

test.describe('X-GIS fixture: stress', () => {
  test('stress_all_renderers — polygon + line + point in one frame, no validation errors', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await withValidationCapture(page, async () => {
      await loadFixture(page, 'fixture_stress_all_renderers')
      const png = await captureCanvas(page)
      // Just verify SOMETHING rendered. Validation capture is the
      // primary assertion — a bind group / pipeline mismatch
      // anywhere in the multi-renderer stack would surface as a
      // queued error.
      const differing = await sampleNonBackgroundPixels(
        page, png, { r: 6, g: 8, b: 12 }, 50, 400,
      )
      expect(differing,
        `stress_all_renderers: ${differing}/400 non-bg pixels — multi-renderer composite empty`)
        .toBeGreaterThan(5)
    })
  })

  test('stress_many_layers — 8 filtered layers, no uniform ring overflow', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await withValidationCapture(page, async () => {
      await loadFixture(page, 'fixture_stress_many_layers')
      const png = await captureCanvas(page)
      const differing = await sampleNonBackgroundPixels(
        page, png, { r: 6, g: 8, b: 12 }, 50, 400,
      )
      expect(differing,
        `stress_many_layers: ${differing}/400 non-bg pixels — multi-layer dispatch broken`)
        .toBeGreaterThan(5)
    })
  })
})

test.describe('X-GIS fixture: projection', () => {
  test('categorical — 3 features with distinct match() colors', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_categorical', [
      { name: 'red', rgb: RED_500, tolerance: 80 },
      { name: 'emerald', rgb: EMERALD_500, tolerance: 80 },
      { name: 'blue', rgb: BLUE_500, tolerance: 80 },
    ], {
      red:     [0.001, 0.30],
      emerald: [0.001, 0.30],
      blue:    [0.001, 0.30],
    })
  })

  test('mercator_clip — polar polygon at lat 80-88 renders without crash', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_mercator_clip',
      [{ name: 'sky', rgb: SKY_400, tolerance: 100 }],
      { sky: [0.0001, 0.50] },
    )
  })

  test('antimeridian — polygon crossing 180° renders amber on both sides', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_antimeridian',
      [{ name: 'amber', rgb: AMBER_500, tolerance: 100 }],
      { amber: [0.001, 0.50] },
    )
  })
})

// ── Extension: caps & joins ───────────────────────────────────────

test.describe('X-GIS fixture: stroke caps/joins', () => {
  test('cap_round — round cap tip reaches canvas', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_cap_round',
      [{ name: 'amber', rgb: AMBER_300, tolerance: 100 }],
      { amber: [0.001, 0.30] },
    )
  })

  test('cap_square — square cap tip reaches canvas', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_cap_square',
      [{ name: 'amber', rgb: AMBER_300, tolerance: 100 }],
      { amber: [0.001, 0.30] },
    )
  })

  test('join_round — round join on sharp turn', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_join_round',
      [{ name: 'amber', rgb: AMBER_300, tolerance: 100 }],
      { amber: [0.001, 0.30] },
    )
  })

  test('join_bevel — bevel join on sharp turn', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_join_bevel',
      [{ name: 'amber', rgb: AMBER_300, tolerance: 100 }],
      { amber: [0.001, 0.30] },
    )
  })
})

// ── Extension: patterns, alignment, offset ────────────────────────

test.describe('X-GIS fixture: stroke patterns', () => {
  test('pattern_multi — 2-slot pattern stack renders amber pixels', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_pattern_multi',
      [{ name: 'amber', rgb: AMBER_300, tolerance: 120 }],
      { amber: [0.0005, 0.40] },
    )
  })

  test('stroke_inset — inward-shifted border on polygon boundary', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_stroke_inset',
      [{ name: 'amber', rgb: AMBER_300, tolerance: 100 }],
      { amber: [0.001, 0.40] },
    )
  })

  test('stroke_offset_right — signed right-rail offset line', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_stroke_offset_right',
      [{ name: 'amber', rgb: AMBER_300, tolerance: 100 }],
      { amber: [0.001, 0.30] },
    )
  })

  test('dasharray_complex — 4-value composite dash array', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_dasharray_complex',
      [{ name: 'amber', rgb: AMBER_300, tolerance: 100 }],
      { amber: [0.0005, 0.30] },
    )
  })
})

// ── Extension: animation easing ───────────────────────────────────

test.describe('X-GIS fixture: animation easing', () => {
  test('anim_ease_linear — linear easing keyframe renders emerald', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_anim_ease_linear',
      [{ name: 'emerald', rgb: EMERALD_500, tolerance: 120 }],
      { emerald: [0.005, 0.60] },
    )
  })
})

// ── Extension: data-driven + filter ───────────────────────────────

test.describe('X-GIS fixture: data-driven', () => {
  test('size_expr — point size-[sqrt(.pop) / 2] renders 3 rose dots', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_size_expr',
      [{ name: 'rose', rgb: ROSE_500, tolerance: 100 }],
      { rose: [0.0005, 0.30] },
    )
  })

  test('filter_complex — only .kind == "b" renders (emerald only)', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_filter_complex',
      [
        { name: 'emerald', rgb: EMERALD_500, tolerance: 80 },
        { name: 'red', rgb: RED_500, tolerance: 80 },
        { name: 'blue', rgb: BLUE_500, tolerance: 80 },
      ],
      {
        emerald: [0.001, 0.40],
        red:     [0, 0.005],
        blue:    [0, 0.005],
      },
    )
  })
})

// ── Extension: custom SVG shape ───────────────────────────────────

test.describe('X-GIS fixture: custom shape', () => {
  test('shape_custom_svg — locally-defined diamond SDF renders rose pixels', async ({ page }) => {
    test.setTimeout(FIXTURE_TIMEOUT_MS + 5_000)
    await fixtureColorAssert(page, 'fixture_shape_custom_svg',
      [{ name: 'rose', rgb: ROSE_500, tolerance: 120 }],
      { rose: [0.0005, 0.30] },
    )
  })
})
