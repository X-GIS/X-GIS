import { test, expect } from '@playwright/test'
import { captureCanvas, colorHistogram } from './helpers/visual'

// Real-GPU E2E for the MULTI-DAY flow-map: 3 days of .odb decoded once, played back
// on a date×hour scrubber. Asserts (1) flow-lines rasterise, (2) the timeline animates
// across frames (proving the n-day scrubber works, not just a single static day).
test.describe('수도권 생활이동 multi-day — date×hour timeline renders + animates', () => {
  test('flow-lines rasterise AND the date×hour timeline animates', async ({ page }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
    })

    await page.goto('/seoul-arc-multiday.html', { waitUntil: 'domcontentloaded' })
    const png0 = await captureCanvas(page, { readyTimeoutMs: 30_000 })
    const h = await colorHistogram(page, png0, [
      { name: 'orange', rgb: [251, 146, 60] as [number, number, number], tolerance: 55 },
    ])

    // Advance past a couple of 600ms frames — the (day,hour) changes → frame differs.
    await page.waitForTimeout(2000)
    const png1 = await captureCanvas(page)
    const animated = !png0.equals(png1)

    // eslint-disable-next-line no-console
    console.log(`[multiday] orange ${(h.orange * 100).toFixed(3)}%  animated=${animated}`)
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
    expect(h.orange, 'flow-lines must rasterise').toBeGreaterThan(0.0003)
    expect(animated, 'date×hour timeline must animate').toBe(true)
  })
})
