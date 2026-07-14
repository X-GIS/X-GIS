import { test, expect } from '@playwright/test'
import { captureCanvas, colorHistogram } from './helpers/visual'

// Real-GPU E2E for the full OD pipeline: a 280KB .odb (aggregated OFFLINE from the
// 345MB/5.2M-row real OA-22300 CSV) is fetched + decoded + rendered by the hero
// page via the custom `odbLoader` on the source-loader seam. Proves raw→offline→
// deploy→hero end-to-end, on the real Windows GPU (headed).
test.describe('수도권 생활이동 .odb hero — real OD renders on real GPU', () => {
  test('the .odb loader decodes + bubbles rasterise (inflow per 자치구)', async ({ page }) => {
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

    await page.goto('/seoul-odb-hero.html', { waitUntil: 'domcontentloaded' })
    const png = await captureCanvas(page, { readyTimeoutMs: 30_000 })

    // The custom .odb branch ran for this type — proves the registry routed it.
    const ranFor = await page.evaluate(
      () => (window as unknown as { __xgisCustomLoaderRan?: string }).__xgisCustomLoaderRan,
    )
    expect(ranFor, 'the x-seoul-odb custom loader must run').toBe('x-seoul-odb')

    // Inflow bubbles (orange) must rasterise — not a blank seed.
    const h = await colorHistogram(page, png, [
      { name: 'orange', rgb: [251, 146, 60] as [number, number, number], tolerance: 55 },
    ])

    console.log(`[odb hero] orange-bubble coverage: ${(h.orange * 100).toFixed(3)}%`)
    if (notFound.length > 0) {
      console.log(`[odb hero] 404s (non-fatal): ${notFound.join(', ')}`)
    }
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
    expect(h.orange, '.odb inflow bubbles must rasterise').toBeGreaterThan(0.0005)
  })
})
