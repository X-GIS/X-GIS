import { test, expect } from '@playwright/test'

// Gate for map.project() (the debug-measurement primitive + MapLibre parity).
// project(center) must land at ~canvas centre; a +N° lon offset must move the
// projected x by a sane, monotonic amount. Real-GPU (headed) so the live MVP
// is exercised, not a mock.
test('map.project(): center→canvas-centre, lon offset monotone', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.goto('/demo.html?id=minimal#3/20.0/0.0', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  await page
    .waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 60_000 },
    )
    .catch(() => {})
  await page.waitForTimeout(2_000)

  const r = await page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: {
          project: (ll: [number, number]) => [number, number] | null
          unproject: (s: [number, number]) => [number, number] | null
          getCenter: () => [number, number]
        }
      }
    ).__xgisMap
    if (!m?.project || !m?.unproject) return { ok: false }
    // project() returns CSS px relative to the CANVAS top-left, so compare to
    // the canvas's own CSS dimensions (demo.html has a control sidebar → the
    // canvas is NOT the full window).
    const cv = document.querySelector('canvas') as HTMLCanvasElement
    const rect = cv.getBoundingClientRect()
    const cssW = rect.width,
      cssH = rect.height
    const c = m.getCenter()
    const pc = m.project(c)
    const pe = m.project([c[0] + 10, c[1]]) // +10° lon → screen moves +x
    const un = pc ? m.unproject(pc) : null // round-trip: unproject(project(c)) ≈ c
    return { ok: true, c, cssW, cssH, pc, pe, un }
  })

  expect(r.ok).toBe(true)
  expect(r.pc).not.toBeNull()
  // center projects to ~canvas centre (within 2% of the smaller dimension)
  const tol = Math.min(r.cssW!, r.cssH!) * 0.02
  expect(Math.abs(r.pc![0] - r.cssW! / 2)).toBeLessThan(tol)
  expect(Math.abs(r.pc![1] - r.cssH! / 2)).toBeLessThan(tol)
  // a +lon offset moves the projected x to the right (east), monotone + sane
  expect(r.pe).not.toBeNull()
  expect(r.pe![0]).toBeGreaterThan(r.pc![0])
  expect(r.pe![0] - r.pc![0]).toBeLessThan(r.cssW!) // not flung off
  // unproject(project(center)) round-trips back to center (≤ 0.05°)
  expect(r.un).not.toBeNull()
  expect(Math.abs(r.un![0] - r.c![0])).toBeLessThan(0.05)
  expect(Math.abs(r.un![1] - r.c![1])).toBeLessThan(0.05)
  console.log('[project] center', r.c, '→', r.pc, '| +10°lon →', r.pe, '| unproject(pc)→', r.un)
})
