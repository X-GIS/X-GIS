import { test, expect } from '@playwright/test'
import { captureCanvas, colorHistogram } from './helpers/visual'

// Real-GPU E2E for the "숨쉬는 도시" breathing choropleth: every 자치구 is coloured by its per-hour
// NET flow (유입 warm/red ↔ 유출 cool/blue) and recoloured across 24h via setPaintProperty (never
// re-tiled — the v1 flicker/seam fix). Asserts (1) BOTH diverging poles rasterise at the AM peak,
// (2) the frame changes h8→h18 (the city breathes / reverses), (3) no console/page errors.
// (The movement vector field is a separate #vfield 2D overlay; this gate covers the #map choropleth.)
test.describe('숨쉬는 도시 — breathing choropleth renders both poles + animates', () => {
  test('유입(red) + 유출(blue) both present at h8, frame differs at h18', async ({ page }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
    })

    await page.goto('/seoul-arc-multiday.html', { waitUntil: 'domcontentloaded' })
    await captureCanvas(page, { readyTimeoutMs: 30_000 })
    await page.click('#play') // pause for deterministic frames

    const setHour = async (h: number): Promise<void> => {
      await page.evaluate((hh) => {
        const s = document.getElementById('scrubber') as HTMLInputElement
        s.value = String(hh)
        s.dispatchEvent(new Event('input'))
      }, h)
    }

    await setHour(8)
    const h8 = await captureCanvas(page)
    const c8 = await colorHistogram(page, h8, [
      { name: 'red', rgb: [220, 38, 38] as [number, number, number], tolerance: 55 },
      { name: 'blue', rgb: [30, 58, 138] as [number, number, number], tolerance: 50 },
      // The GPU arrow vector field (map.graphics.add type:'arrow') renders amber INTO #map.
      { name: 'amber', rgb: [253, 224, 130] as [number, number, number], tolerance: 40 },
    ])
    await setHour(18)
    const h18 = await captureCanvas(page)
    const animated = !h8.equals(h18)

    console.log(
      `[breathing] h8 red ${(c8.red * 100).toFixed(2)}% blue ${(c8.blue * 100).toFixed(2)}% amber ${(c8.amber * 100).toFixed(2)}% animated=${animated}`,
    )
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
    expect(c8.red, '유입(red) must rasterise').toBeGreaterThan(0.01)
    expect(c8.blue, '유출(blue) must rasterise').toBeGreaterThan(0.01)
    expect(c8.amber, 'GPU arrow vector field must rasterise').toBeGreaterThan(0.001)
    expect(animated, 'the city must breathe (h8 ≠ h18)').toBe(true)
  })
})
