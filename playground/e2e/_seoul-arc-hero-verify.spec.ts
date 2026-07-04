import { test, expect } from '@playwright/test'
import { captureCanvas, colorHistogram } from './helpers/visual'

// Real-GPU E2E for the OD flow-LINE hero: the ~26KB .odb fixture is decoded ONCE,
// then per-hour odFlow LineStrings are re-injected via setSourceData (the animation
// path — the seam is construction-immutable). Proves the odFlow encoder → LineString
// FC → geojson line render works on the real GPU (headed). Straight flow-lines;
// curved arcs are a deferred draper follow-up.
test.describe('수도권 생활이동 flow-lines — odFlow renders on real GPU', () => {
  test('odFlow LineStrings rasterise (orange flow-lines over Seoul)', async ({ page }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    const notFound: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
    })
    page.on('response', (r) => {
      if (r.status() === 404) notFound.push(r.url())
    })

    await page.goto('/seoul-arc-hero.html', { waitUntil: 'domcontentloaded' })
    const png = await captureCanvas(page, { readyTimeoutMs: 30_000 })

    // Orange flow-lines (stroke-orange-400) must rasterise — the odFlow LineString FC
    // rendered through the geojson line path.
    const h = await colorHistogram(page, png, [
      { name: 'orange', rgb: [251, 146, 60] as [number, number, number], tolerance: 55 },
    ])
    // eslint-disable-next-line no-console
    console.log(`[flow-lines] orange-line coverage: ${(h.orange * 100).toFixed(3)}%`)
    if (notFound.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[flow-lines] 404s (non-fatal): ${notFound.join(', ')}`)
    }
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
    expect(h.orange, 'odFlow flow-lines must rasterise (orange stroke present)').toBeGreaterThan(
      0.0003,
    )
  })
})
