import { test, expect } from '@playwright/test'
import { captureCanvas, colorHistogram } from './helpers/visual'

// Real-GPU render gate for the DECLARATIVE custom source-loader seam
// (seoul-loader.html). A `.xgis` `source flows { type: x-kr-admin }` — a type the
// 7 built-ins don't cover — is resolved by a per-map `krAdminLoader` registered at
// construction: fetch a code-keyed CSV → join to 시군구 centroids → bubble FC →
// routed through the SAME `_attachGeoJSONViaVirtualPMTiles` path as a built-in
// geojson source. HEADED (real Windows GPU). Design: docs/architecture/source-loader-seam.md.
test.describe('custom source-loader seam — declarative x-kr-admin renders on real GPU', () => {
  test('the custom branch runs AND its bubbles rasterise (not a blank seed)', async ({ page }) => {
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

    await page.goto('/seoul-loader.html', { waitUntil: 'domcontentloaded' })
    const png = await captureCanvas(page, { readyTimeoutMs: 30_000 })

    // (1) The CUSTOM dispatch branch actually ran for this type — proves the
    // registry was consulted and routed through the tiled attach path, NOT that
    // some unrelated pixels happened to appear.
    const ranFor = await page.evaluate(
      () => (window as unknown as { __xgisCustomLoaderRan?: string }).__xgisCustomLoaderRan,
    )
    expect(ranFor, 'the custom source-loader branch must run for x-kr-admin').toBe('x-kr-admin')

    // (2) Its bubbles must RASTERISE (orange fill) — a bare-seed blank frame would
    // pass (1) but fail here, which is exactly the §5-parity trap the gate closes.
    const h = await colorHistogram(page, png, [
      { name: 'orange', rgb: [249, 115, 22] as [number, number, number], tolerance: 55 },
    ])
    // eslint-disable-next-line no-console
    console.log(`[source-loader demo] orange-bubble coverage: ${(h.orange * 100).toFixed(3)}%`)
    if (notFound.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[source-loader demo] 404s (non-fatal): ${notFound.join(', ')}`)
    }
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
    expect(h.orange, 'custom-loader bubbles must rasterise (orange fill present)').toBeGreaterThan(
      0.001,
    )
  })
})
