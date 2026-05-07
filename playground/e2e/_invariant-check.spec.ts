// Activates the production invariant (visibility/fallback consistency
// check) and exercises the demo paths that are most likely to expose
// state-machine bugs:
//   - Cold load + settle
//   - Zoom-in (the path that exposed commit-49d4801's white flash)
//   - Zoom-out
//   - Pan + bearing rotate
//
// Any frame that violates the invariant THROWS in the per-layer loop;
// the page-level error listener captures it and the test fails with
// the precise (z, x, y, layer) coordinates.

import { test, expect } from '@playwright/test'

interface XgisMap {
  vtSources?: Map<string, { renderer: { _hysteresisZ?: number } }>
  camera?: { zoom: number; pitch?: number; bearing?: number; centerX: number; centerY: number }
}
declare global {
  interface Window {
    __xgisMap?: XgisMap
    __xgisReady?: boolean
    __XGIS_INVARIANTS?: boolean
  }
}

test.describe('Production invariant — visibility / fallback consistency', () => {
  test.use({ viewport: { width: 1500, height: 907 } })

  test('pmtiles_layered cold-load → zoom-in → zoom-out → pan: no invariant violation', async ({ page }) => {
    test.setTimeout(90_000)

    // Capture page errors so an invariant throw inside the runtime
    // surfaces as a test failure with the message intact.
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', m => {
      if (m.type() === 'error' && m.text().includes('XGIS INVARIANT')) errors.push(m.text())
    })

    // Activate the invariant BEFORE the runtime mounts so the very
    // first render frame is checked.
    await page.addInitScript(() => {
      ;(window as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS = true
    })

    // Phase 0: prove pre-fix bug is detectable. Pin upload budget
    // to 0 so EVERY uploadTile() call queues. The pre-fix `continue`
    // after uploadTile was a per-tile decision = 'queued-no-fb';
    // post-fix lets the parent-walk run, producing 'parent-fallback'
    // for tiles whose ancestor is cached.

    await page.goto(
      `/demo.html?id=pmtiles_layered#10/37.5665/126.978/0/0`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(() => window.__xgisReady === true, null, { timeout: 30_000 })
    await page.waitForFunction(() => {
      const map = window.__xgisMap
      if (!map?.vtSources) return false
      let cz = -1
      for (const { renderer } of map.vtSources.values()) cz = renderer._hysteresisZ ?? cz
      return cz >= 9
    }, null, { timeout: 30_000 })
    await page.waitForTimeout(3000)

    // Phase A: budget=0 zoom-in (the bug-trigger condition for
    // commit-49d4801)
    await page.evaluate(() => {
      (window as { __XGIS_UPLOAD_BUDGET?: number }).__XGIS_UPLOAD_BUDGET = 0
    })
    await page.evaluate(() => { window.__xgisMap!.camera!.zoom = 13 })
    await page.waitForTimeout(5000)
    expect(errors, `invariant violations during zoom-in:\n${errors.join('\n')}`).toEqual([])

    // Restore normal budget for subsequent phases
    await page.evaluate(() => {
      (window as { __XGIS_UPLOAD_BUDGET?: number }).__XGIS_UPLOAD_BUDGET = undefined
    })

    // Phase B: zoom-out
    await page.evaluate(() => { window.__xgisMap!.camera!.zoom = 9 })
    await page.waitForTimeout(3000)
    expect(errors, `invariant violations during zoom-out:\n${errors.join('\n')}`).toEqual([])

    // Phase C: pan + bearing rotation
    await page.evaluate(async () => {
      const cam = window.__xgisMap!.camera!
      const cx0 = cam.centerX, cy0 = cam.centerY
      const t0 = performance.now()
      while (performance.now() - t0 < 2000) {
        await new Promise<void>(r => requestAnimationFrame(() => r()))
        const t = (performance.now() - t0) / 2000
        cam.centerX = cx0 + Math.sin(t * Math.PI * 2) * 30_000
        cam.centerY = cy0 + Math.cos(t * Math.PI * 2) * 30_000
        cam.bearing = (cam.bearing ?? 0) + 1
      }
    })
    await page.waitForTimeout(1000)
    expect(errors, `invariant violations during pan+rotate:\n${errors.join('\n')}`).toEqual([])

    console.log('[invariant-check] zero violations across cold-load + zoom-in + zoom-out + pan+rotate')
  })
})
