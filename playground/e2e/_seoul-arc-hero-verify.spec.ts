import { test, expect } from '@playwright/test'
import { captureCanvas, colorHistogram } from './helpers/visual'

// Real-GPU E2E for the OD flow-LINE hero: the .odb fixture is decoded ONCE, then
// per-hour odFlow LineStrings are re-injected via setSourceData on a 2.5s pulse.
// Two assertions: (1) orange flow-lines rasterise, (2) the DAILY PULSE actually
// animates — two captures >1 cycle apart must differ (regression guard for the
// st_time_cd u8-overflow bug that scrambled the hour column and froze the pulse).
test.describe('수도권 생활이동 flow-lines — odFlow renders + animates on real GPU', () => {
  test('odFlow LineStrings rasterise AND the daily pulse animates', async ({ page }) => {
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
    const png0 = await captureCanvas(page, { readyTimeoutMs: 30_000 })

    // (1) Orange flow-lines must rasterise.
    const h = await colorHistogram(page, png0, [
      { name: 'orange', rgb: [251, 146, 60] as [number, number, number], tolerance: 55 },
    ])

    // (2) Wait past one pulse cycle (2.5s) — the hour changes → different flows →
    // the frame MUST differ. A frozen pulse (the u8-overflow bug) would be identical.
    await page.waitForTimeout(3300)
    const png1 = await captureCanvas(page)
    const animated = !png0.equals(png1)

    // eslint-disable-next-line no-console
    console.log(`[flow-lines] orange ${(h.orange * 100).toFixed(3)}%  animated=${animated}`)
    if (notFound.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[flow-lines] 404s (non-fatal): ${notFound.join(', ')}`)
    }
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
    expect(h.orange, 'odFlow flow-lines must rasterise (orange stroke present)').toBeGreaterThan(
      0.0003,
    )
    expect(animated, 'daily pulse must animate — frames must differ across an hour change').toBe(
      true,
    )
  })
})
