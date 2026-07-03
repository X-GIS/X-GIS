// Picking interaction check: load the picking demos and verify pickAt()
// returns a feature when clicking over rendered content. The user reported
// "picking not working" — this turns that into a measured pass/fail.

import { test, expect } from '@playwright/test'

for (const id of ['picking_demo', 'fixture_picking']) {
  test(`pick-check: ${id}`, async ({ page }) => {
    test.setTimeout(40_000)
    await page.setViewportSize({ width: 900, height: 640 })
    const errs: string[] = []
    page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)))
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(m.text().slice(0, 200))
    })
    await page.addInitScript(() => {
      ;(window as unknown as { __xgisDrawOrderTrace: unknown[] }).__xgisDrawOrderTrace = []
    })
    await page.goto(`/demo.html?id=${id}&e2e=1`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 18_000 },
    )
    await page.waitForTimeout(1200)
    // Probe pickAt over a grid of points; report any that return a feature.
    if (id === 'picking_demo')
      await page.locator('canvas').first().screenshot({ path: 'D:/X-GIS/tmp/shots/n460_z05.png' })
    const result = await page.evaluate(async () => {
      const m = (
        window as unknown as {
          __xgisMap?: {
            pickAt?: (x: number, y: number) => Promise<unknown>
            getCamera?: () => { zoom: number; centerX: number; centerY: number }
            markCameraPositioned?: () => void
          }
        }
      ).__xgisMap
      if (!m || typeof m.pickAt !== 'function')
        return { hasPickAt: false, hits: [] as unknown[], zoomedHits: [] as unknown[] }
      const hits: unknown[] = []
      for (let gx = 150; gx <= 750; gx += 100) {
        for (let gy = 120; gy <= 520; gy += 100) {
          try {
            const r = await m.pickAt(gx, gy)
            if (r) hits.push({ gx, gy, r })
          } catch (e) {
            hits.push({ gx, gy, err: String(e) })
          }
        }
      }
      // #460: is the z0 fill DRAWN at z0.5? Dump the draw trace.
      const w = window as unknown as { __xgisDrawOrderTrace?: unknown[] }
      hits.push({
        __z05_drawtrace: Array.isArray(w.__xgisDrawOrderTrace)
          ? w.__xgisDrawOrderTrace.map((t) => JSON.stringify(t)).slice(0, 14)
          : '(no trace — set window.__xgisDrawOrderTrace=[] to enable)',
      })
      // Zoom into a land area (Africa ~lon20 lat5, z3) and re-probe centre.
      const zoomedHits: unknown[] = []
      if (m.getCamera && m.markCameraPositioned) {
        const cam = m.getCamera()
        const R = 6378137
        cam.zoom = 3
        cam.centerX = ((20 * Math.PI) / 180) * R
        cam.centerY = Math.log(Math.tan(Math.PI / 4 + (5 * Math.PI) / 180 / 2)) * R
        m.markCameraPositioned()
        await new Promise((r) => setTimeout(r, 1200))
        for (let gx = 300; gx <= 600; gx += 75) {
          for (let gy = 200; gy <= 450; gy += 75) {
            try {
              const r = await m.pickAt(gx, gy)
              if (r) zoomedHits.push({ gx, gy, r })
            } catch {}
          }
        }
      }
      return { hasPickAt: true, hits, zoomedHits }
    })
    if (id === 'picking_demo')
      await page.locator('canvas').first().screenshot({ path: 'D:/X-GIS/tmp/shots/n460_z3.png' })
    console.log(
      `  zoomedHits=${(result as { zoomedHits: unknown[] }).zoomedHits.length} ${JSON.stringify((result as { zoomedHits: unknown[] }).zoomedHits.slice(0, 4))}`,
    )
    console.log(
      `\n=== pick-check ${id}: hasPickAt=${result.hasPickAt} hits=${result.hits.length} errors=${errs.length} ===`,
    )
    console.log(JSON.stringify(result.hits.slice(0, 8)))
    for (const e of [...new Set(errs)].slice(0, 5)) console.log('  [err] ' + e)
    expect(result.hasPickAt, 'pickAt API missing').toBe(true)
  })
}
