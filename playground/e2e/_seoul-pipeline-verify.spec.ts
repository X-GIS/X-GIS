import { test, expect } from '@playwright/test'
import { captureCanvas, colorHistogram } from './helpers/visual'

// Real-GPU render gate for the @xgis/pipeline demo (seoul-pipeline.html): the
// data-to-viz pipeline (sample tabular 생활이동 → join to the 시군구 gazetteer →
// groupBy → bubble → setSourcePoints) must actually RASTERISE its bubbles on the
// real map — not just run without error. HEADED (real Windows GPU).
test.describe('@xgis/pipeline — Seoul 생활이동 demo renders on real GPU', () => {
  test('the pipeline bubbles rasterise (warm ramp over Seoul)', async ({ page }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    const notFound: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      // A resource 404 surfaces as a generic console error with no URL — track it
      // separately (non-fatal: it doesn't break the pipeline render) via `response`.
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
    })
    page.on('response', (r) => {
      if (r.status() === 404) notFound.push(r.url())
    })

    await page.goto('/seoul-pipeline.html', { waitUntil: 'domcontentloaded' })
    const png = await captureCanvas(page, { readyTimeoutMs: 30_000 })

    // The four bubble tiers use a warm ramp (amber→orange→red); assert a
    // non-trivial coverage of that ramp = the pipeline's points painted.
    const ramp = [
      { name: 'amber', rgb: [252, 211, 77] as [number, number, number], tolerance: 60 },
      { name: 'orange', rgb: [249, 115, 22] as [number, number, number], tolerance: 55 },
      { name: 'red', rgb: [239, 68, 68] as [number, number, number], tolerance: 55 },
    ]
    const h = await colorHistogram(page, png, ramp)
    const warm = h.amber + h.orange + h.red
    // eslint-disable-next-line no-console
    console.log(
      `[pipeline demo] warm-bubble coverage: amber=${(h.amber * 100).toFixed(2)}% ` +
        `orange=${(h.orange * 100).toFixed(2)}% red=${(h.red * 100).toFixed(2)}% total=${(warm * 100).toFixed(2)}%`,
    )
    if (notFound.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[pipeline demo] 404s (non-fatal): ${notFound.join(', ')}`)
    }
    // The gate is that the pipeline's bubbles RASTERISE + no real JS error fires.
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
    expect(warm, 'pipeline bubbles must rasterise (warm ramp present)').toBeGreaterThan(0.001)
  })
})
