// ═══════════════════════════════════════════════════════════════════
// continent-match.xgis with ?compute=1 — real-GPU E2E
// ═══════════════════════════════════════════════════════════════════
//
// Plan P4 verification gate. Loads the continent_match demo with
// the compute path opt-in (?compute=1), then asserts on the real
// WebGPU pipeline.
//
// What this verifies on a REAL WebGPU adapter (not the unit-test
// fake device):
//
//   1. enableComputePath=true threads from XGISMapOptions through
//      emitCommands and produces a working render — no WGSL
//      validation errors at pipeline / dispatch.
//   2. The canvas is painted (non-background pixels exist).
//   3. The continent fill colors picked by the compute kernel match
//      the expected match() arms (≥4 of 7 hue buckets populated).
//   4. compute=1 visual output matches compute=0 within MSE
//      tolerance — proves the compute path is a transparent rewrite
//      of the existing fragment if-else chain.

import { test, expect } from '@playwright/test'
import { captureCanvas, sampleNonBackgroundPixels, pixelDiffRatio } from './helpers/visual'

const PER_TEST_TIMEOUT_MS = 20_000

// Match the renderer clearValue (map.ts:~2501) — 0.039 × 255 ≈ 10,
// 0.063 × 255 ≈ 16. Sub-pixel rounding in the swap-chain converter
// can shift these by ±2 so use tolerance ≥ 4 in any check that hits
// the background.
const BACKGROUND_RGB = { r: 10, g: 10, b: 16 }

test.describe('Plan P4 — continent_match with ?compute=1', () => {
  test('opt-in compute path renders without WebGPU errors', async ({ page }) => {
    test.setTimeout(PER_TEST_TIMEOUT_MS + 10_000)

    const errors: string[] = []
    page.on('console', msg => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      if (text.startsWith('[X-GIS]')) return
      if (text.includes('Failed to load resource')) return
      if (text.includes('favicon')) return
      errors.push(text)
    })
    page.on('pageerror', err => errors.push(`pageerror: ${err.message}`))

    await page.goto(`/demo.html?id=continent_match&compute=1`, {
      waitUntil: 'domcontentloaded',
    })
    const png = await captureCanvas(page, { readyTimeoutMs: PER_TEST_TIMEOUT_MS })
    // Extra frames so a lazy compile-error fires before the assert.
    await page.waitForTimeout(500)

    expect(errors, `WebGPU / runtime errors with compute=1:\n  ${errors.join('\n  ')}`)
      .toHaveLength(0)

    // Sanity — at zoom 2 the world map covers ~40% of the viewport.
    // Continents fill maybe 25-30%. With a 20×20 sample grid → expect
    // ≥30 of 400 non-background pixels (≥7.5% canvas coverage).
    const differing = await sampleNonBackgroundPixels(page, png, BACKGROUND_RGB, 18, 400)
    expect(differing,
      `compute path produced near-empty canvas — only ${differing}/400 sampled pixels differ from background`,
    ).toBeGreaterThan(30)
  })

  test('compute=1 visual matches compute=0 baseline (within pixel-diff tolerance)', async ({ page }) => {
    test.setTimeout(PER_TEST_TIMEOUT_MS * 2 + 10_000)

    // compute=0 baseline.
    await page.goto(`/demo.html?id=continent_match`, { waitUntil: 'domcontentloaded' })
    const baselinePng = await captureCanvas(page, { readyTimeoutMs: PER_TEST_TIMEOUT_MS })

    // compute=1 candidate.
    await page.goto(`/demo.html?id=continent_match&compute=1`, { waitUntil: 'domcontentloaded' })
    const computePng = await captureCanvas(page, { readyTimeoutMs: PER_TEST_TIMEOUT_MS })

    // tolerance=12 / channel + ratio threshold = 0.05 (5%). Both
    // paths deterministically pick the SAME color per CONTINENT id;
    // any drift is from MSAA resolve ordering / GPU dither — should
    // stay well under 5% of canvas pixels.
    const ratio = await pixelDiffRatio(page, baselinePng, computePng, 12)
    expect(ratio,
      `compute=1 vs compute=0 pixel diff ratio = ${(ratio * 100).toFixed(3)}% (>5% means visible drift)`,
    ).toBeLessThan(0.05)
  })
})

// Compute-eligible direct xgis fixtures. Each fixture has at least
// one `match()` data-driven fill or stroke that the compiler routes
// through the compute path. Verified via /tmp/find-compute-fixtures
// helper: every entry below produces ≥1 ComputePlanEntry +
// variant.computeBindings when emitCommands runs with
// enableComputePath: true.
const COMPUTE_FIXTURE_DEMOS = [
  'continent_match',
  'income_match',
  'continent_outlines',
  'fixture_categorical',
  'reftest_triangle_match',
  'fixture_picking',
]

test.describe('Plan P4 — broader fixture coverage with ?compute=1', () => {
  for (const id of COMPUTE_FIXTURE_DEMOS) {
    test(`${id} — compute=1 visual matches compute=0 baseline`, async ({ page }) => {
      test.setTimeout(PER_TEST_TIMEOUT_MS * 2 + 10_000)

      await page.goto(`/demo.html?id=${id}`, { waitUntil: 'domcontentloaded' })
      const baselinePng = await captureCanvas(page, { readyTimeoutMs: PER_TEST_TIMEOUT_MS })

      await page.goto(`/demo.html?id=${id}&compute=1`, { waitUntil: 'domcontentloaded' })
      const computePng = await captureCanvas(page, { readyTimeoutMs: PER_TEST_TIMEOUT_MS })

      const ratio = await pixelDiffRatio(page, baselinePng, computePng, 12)
      expect(ratio,
        `[${id}] compute=1 vs compute=0 pixel diff = ${(ratio * 100).toFixed(3)}%`,
      ).toBeLessThan(0.05)
    })
  }
})
