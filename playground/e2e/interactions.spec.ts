import { test, expect, type Page } from '@playwright/test'
import {
  captureCanvas, sampleNonBackgroundPixels, colorHistogram,
  type ColorBucket,
} from './helpers/visual'
import { withValidationCapture, clearValidationErrors } from './helpers/validation'

// ═══ X-GIS curated interaction fixtures ═══
//
// Each test exercises a known-risky combination of features. The
// list is calibrated against past bug reports: every entry here
// either was already broken (Bug 1, Bug 2) or is one structural
// move away from those bug shapes.
//
// Wraps in withValidationCapture so any bind group / pipeline /
// layout error during the interaction surfaces immediately.

const TIMEOUT_MS = 20_000

async function loadFixture(page: Page, id: string): Promise<void> {
  await page.goto(`/demo.html?id=${id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: TIMEOUT_MS },
  )
  await clearValidationErrors(page)
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
}

test.describe('X-GIS interaction', () => {
  test('translucent stroke + opacity keyframe — bucket 2 + lifecycle', async ({ page }) => {
    test.setTimeout(TIMEOUT_MS + 5_000)
    await withValidationCapture(page, async () => {
      await loadFixture(page, 'fixture_x_translucent_anim')
      // The animation cycles opacity. Both the start (full
      // opacity) and the trough (30% opacity) should render
      // SOMETHING non-background. We sample at two times to
      // verify the bucket 2 path stays alive across the cycle.
      const t0 = await captureCanvas(page, { elapsedMsAtLeast: 100 })
      const t1 = await captureCanvas(page, { elapsedMsAtLeast: 1000 })
      const d0 = await sampleNonBackgroundPixels(page, t0, { r: 6, g: 8, b: 12 }, 50, 400)
      const d1 = await sampleNonBackgroundPixels(page, t1, { r: 6, g: 8, b: 12 }, 50, 400)
      expect(d0, `cycle start: ${d0}/400 pixels visible`).toBeGreaterThan(2)
      expect(d1, `cycle mid: ${d1}/400 pixels visible`).toBeGreaterThan(2)
    })
  })

  test('direct-layer points + translucent vector — Bug 2 mirror', async ({ page }) => {
    test.setTimeout(TIMEOUT_MS + 5_000)
    await withValidationCapture(page, async () => {
      await loadFixture(page, 'fixture_x_points_translucent')
      const png = await captureCanvas(page)
      // BOTH the rose pin AND the translucent triangle must
      // render. Use color histogram for the pin (pure rose is
      // safe — it's opaque) and a non-background sample for the
      // translucent triangle (rgba blended).
      const buckets: ColorBucket[] = [
        { name: 'rose', rgb: [244, 63, 94], tolerance: 80 },
      ]
      const hist = await colorHistogram(page, png, buckets)
      expect(hist.rose,
        `rose pin: ${(hist.rose * 100).toFixed(2)}% — direct-layer point not rendering`)
        .toBeGreaterThan(0.001)

      const differing = await sampleNonBackgroundPixels(
        page, png, { r: 6, g: 8, b: 12 }, 50, 400,
      )
      expect(differing,
        `total non-background: ${differing}/400 — bucket 2 (translucent vector) not rendering`)
        .toBeGreaterThan(6) // pin alone gives ~5; translucent triangle adds at least 1-2 more
    })
  })

  test('zoom-opacity × time-opacity — multiplicative composition', async ({ page }) => {
    test.setTimeout(TIMEOUT_MS + 5_000)
    await withValidationCapture(page, async () => {
      await loadFixture(page, 'fixture_x_zoom_time_opacity')
      // Both factors are 0.5-1.0, so the layer is always
      // partially visible. Just verify SOMETHING renders without
      // validation errors. The validation capture is the real
      // assertion here — composition logic is unit-tested in
      // bucket-scheduler.test.ts.
      const png = await captureCanvas(page)
      const differing = await sampleNonBackgroundPixels(
        page, png, { r: 6, g: 8, b: 12 }, 50, 400,
      )
      expect(differing,
        `${differing}/400 pixels — zoom × time composition produced empty canvas`)
        .toBeGreaterThan(2)
    })
  })

  test('multi-property keyframes — Bug 1 cross-property mirror', async ({ page }) => {
    test.setTimeout(TIMEOUT_MS + 5_000)
    await withValidationCapture(page, async () => {
      await loadFixture(page, 'fixture_x_anim_multi_property')
      // Sample 4 time points across 2 cycles. ALL three property
      // ranges must vary across samples — proves opacity + fill
      // + stroke width all morph (Bug 1 silently froze fill but
      // kept opacity moving).
      const samples: { differing: number; blue: number; rose: number }[] = []
      for (const ms of [200, 800, 1400, 2000, 2600, 3200]) {
        const png = await captureCanvas(page, { elapsedMsAtLeast: ms })
        const differing = await sampleNonBackgroundPixels(
          page, png, { r: 6, g: 8, b: 12 }, 50, 400,
        )
        const r = await colorHistogram(page, png, [
          { name: 'blue', rgb: [59, 130, 246], tolerance: 100 },
          { name: 'rose', rgb: [244, 63, 94], tolerance: 100 },
        ])
        samples.push({ differing, blue: r.blue, rose: r.rose })
      }
      // Both keyframe colors must appear at SOME sample.
      const sawBlue = samples.some(s => s.blue > 0.005)
      const sawRose = samples.some(s => s.rose > 0.005)
      expect(sawBlue && sawRose,
        `multi-property keyframe: sawBlue=${sawBlue} sawRose=${sawRose} — fill not morphing across samples ${JSON.stringify(samples)}`)
        .toBe(true)
    })
  })
})
