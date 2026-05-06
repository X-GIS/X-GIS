// Regression spec for "Tier 2 prefetch keys are aborted by per-frame
// cancelStale". Reproduces the design defect introduced when VTR
// gained per-frame fetch cancellation: activeKeys was built from
// neededKeys ∪ parentKeys ∪ fallbackKeys but NOT the prefetch keys
// that VTR's own Tier 2 path enqueues every 6 frames. Result: each
// prefetch round started fetches that the very next frame's
// cancelStale aborted, defeating the prefetch entirely.
//
// Repro: at zoom 3.6 (currentZ=3 by hysteresis, but
// camera.zoom > currentZ + 0.5 satisfies Tier 2 zoom-in trigger →
// prefetchZ = 4), camera stationary. In a correct implementation
// the visible set never changes, so cancelStale finds nothing to
// abort. In the buggy implementation, every 6 frames Tier 2
// requests z=4 keys that are absent from activeKeys → next frame
// aborts them, repeating forever.
//
// Measurement: spy AbortController.prototype.abort. Stationary
// period of 5 s should yield ~0 aborts on a fixed-camera repro.

import { test, expect } from '@playwright/test'

test.describe('Tier 2 prefetch must survive per-frame cancelStale', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('zoom=3.6 stationary: prefetch keys must not be aborted', async ({ page }) => {
    test.setTimeout(60_000)

    // Install the abort spy BEFORE any navigation so the runtime's
    // AbortController instances inherit the patched prototype from
    // the moment they are constructed.
    await page.addInitScript(() => {
      const w = window as unknown as { __abortCount: number }
      w.__abortCount = 0
      const orig = AbortController.prototype.abort
      AbortController.prototype.abort = function patched(...args: unknown[]) {
        w.__abortCount++
        return orig.apply(this, args as [])
      }
    })

    await page.goto(
      `/demo.html?id=pmtiles_layered#3.0/35.68/139.76`,
      { waitUntil: 'domcontentloaded' },
    )

    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 },
    )
    await page.waitForFunction(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = (window as any).__xgisMap
      if (!map?.vtSources) return false
      let totalVisible = 0
      let pending = 0
      for (const { renderer } of map.vtSources.values()) {
        totalVisible += renderer.getDrawStats?.().tilesVisible ?? 0
        pending += renderer.getPendingUploadCount?.() ?? 0
      }
      return totalVisible > 0 && pending === 0
    }, null, { timeout: 60_000 })
    await page.waitForTimeout(2000)

    // Step camera to zoom 3.6: hysteresis keeps currentZ=3, but
    // camera.zoom > currentZ + 0.5 (=3.5) triggers Tier 2 zoom-in
    // prefetch every 6 frames for z=4.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__xgisMap.camera.zoom = 3.6
    })
    // Brief settle so the initial transition aborts (if any) finish
    // BEFORE we snapshot baseline. Stationary measurement starts after.
    await page.waitForTimeout(500)

    const baseline = await page.evaluate(
      () => (window as unknown as { __abortCount: number }).__abortCount,
    )

    // Camera fully stationary for 5 s. With the prefetch-aware
    // activeKeys, abort count must stay at baseline (active set
    // never changes → nothing to cancel). With the bug, Tier 2
    // fires every ~100 ms (6 rAF) and the next frame aborts each
    // batch — yielding ~50 aborts over 5 s.
    await page.waitForTimeout(5000)

    const final = await page.evaluate(
      () => (window as unknown as { __abortCount: number }).__abortCount,
    )
    const aborted = final - baseline

    console.log(`[abort-during-stationary] baseline=${baseline} final=${final} delta=${aborted}`)

    // Tolerance: with prefetch-aware cancelStale + already-aborted
    // skip, a stationary camera should produce ~0 aborts. We allow
    // up to 100 to absorb tail-end transition activity (initial
    // archive directory walk completing, prefetch-shield expiry on
    // the one-shot prefetchAdjacent set). The bug case (no protection
    // + repeated abort() on stuck controllers) sits ~20 000 — three
    // orders of magnitude above this floor, so the threshold doesn't
    // have to be tight to catch the regression.
    expect(aborted).toBeLessThan(100)
  })
})
