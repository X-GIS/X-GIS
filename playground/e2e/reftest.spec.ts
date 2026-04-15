import { test, expect, type Page } from '@playwright/test'
import { captureCanvas, pixelDiffRatio, sampleNonBackgroundPixels } from './helpers/visual'
import { withValidationCapture, clearValidationErrors } from './helpers/validation'

// ═══ X-GIS reftest pairs ═══
//
// Inspired by Mozilla's reftest pattern (and W3C web-platform-tests).
// Each test loads two fixtures that should render IDENTICALLY via
// different code paths. The byte-equal comparison eliminates the
// PNG baseline maintenance burden — there's no committed expected
// image, just two .xgis files that must produce the same bytes.
//
// When a refactor breaks one path (e.g. categorical shader variant
// drifts from constant), the reftest trips immediately with a
// clear "these two should be identical but aren't" message. No
// human eyes needed to compare to a baseline.
//
// Tolerance: pixel-diff with per-channel tolerance 12 (≈5% per
// channel) and a max diff-pixel-ratio of 0.5%. Byte-equal hash
// comparison was too strict — WebGPU's per-pass MSAA resolve
// produces sub-pixel jitter that's invisible to humans but
// changes hashes. The tolerance here is calibrated to catch
// real semantic divergences (e.g. wrong color, wrong geometry)
// while ignoring rounding noise.

const TIMEOUT_MS = 15_000

async function loadAndCapture(page: Page, id: string): Promise<Buffer> {
  await page.goto(`/demo.html?id=${id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: TIMEOUT_MS },
  )
  await clearValidationErrors(page)
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  return await captureCanvas(page)
}

/** Run a reftest pair: load A, capture, load B, capture, compare
 *  via pixel-diff ratio with small tolerance. Both loads also run
 *  inside validation capture so a pipeline error in either path
 *  surfaces. */
const PIXEL_TOLERANCE = 12          // ±12/255 per channel
const MAX_DIFF_RATIO = 0.005         // ≤0.5% of pixels may differ

async function reftestPair(
  page: Page,
  refA: string,
  refB: string,
  description: string,
): Promise<void> {
  await withValidationCapture(page, async () => {
    const pngA = await loadAndCapture(page, refA)
    const pngB = await loadAndCapture(page, refB)
    const ratio = await pixelDiffRatio(page, pngA, pngB, PIXEL_TOLERANCE)
    if (ratio > MAX_DIFF_RATIO) {
      const diffA = await sampleNonBackgroundPixels(page, pngA, { r: 6, g: 8, b: 12 }, 50, 400)
      const diffB = await sampleNonBackgroundPixels(page, pngB, { r: 6, g: 8, b: 12 }, 50, 400)
      throw new Error(
        `reftest mismatch: ${description}\n` +
        `  ${refA}: non-bg=${diffA}/400\n` +
        `  ${refB}: non-bg=${diffB}/400\n` +
        `  diff ratio: ${(ratio * 100).toFixed(3)}% (max allowed ${(MAX_DIFF_RATIO * 100).toFixed(1)}%)\n` +
        `  → these fixtures should render identically but produced ${(ratio * 100).toFixed(2)}% diverging pixels`,
      )
    }
    // Sanity: both rendered SOMETHING. If they were both empty
    // they would also diff to 0 but that's not a useful pass.
    const diff = await sampleNonBackgroundPixels(page, pngA, { r: 6, g: 8, b: 12 }, 50, 400)
    expect(diff,
      `reftest ${description}: both fixtures rendered an empty canvas (${diff}/400 differing pixels)`)
      .toBeGreaterThan(2)
  })
}

test.describe('X-GIS reftest', () => {
  test('triangle: static fill === match() with single arm', async ({ page }) => {
    test.setTimeout(TIMEOUT_MS + 10_000)
    await reftestPair(page,
      'reftest_triangle_static', 'reftest_triangle_match',
      'static blue fill vs match() resolving to blue',
    )
  })

  test('zoom-opacity: static === degenerate stops at same value', async ({ page }) => {
    test.setTimeout(TIMEOUT_MS + 10_000)
    await reftestPair(page,
      'reftest_zoom_static', 'reftest_zoom_degenerate',
      'static opacity-80 vs z0:opacity-80 z20:opacity-80',
    )
  })

  test('stroke-width: static === degenerate keyframe at same value', async ({ page }) => {
    test.setTimeout(TIMEOUT_MS + 10_000)
    await reftestPair(page,
      'reftest_stroke_static', 'reftest_stroke_keyframe_static',
      'static stroke-12 vs keyframes hold { 0%: stroke-12  100%: stroke-12 }',
    )
  })
})
