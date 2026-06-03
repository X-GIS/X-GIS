// Real-GPU e2e for the two ship-readiness P0s:
//   P0-8 — map lifecycle / camera events (load, movestart/move/moveend,
//          zoomstart/zoom/zoomend, idle) actually FIRE off the live
//          render loop, not just the unit-test signature diff.
//   P0-7 — keyboard a11y: the host canvas is focusable + named for
//          assistive tech, and an ArrowKey keydown drives the camera
//          through the same controller path drag/wheel use.
//
// These are live-engine assertions: they register real `map.on(...)`
// handlers on `window.__xgisMap`, drive a programmatic `jumpTo` + a
// keyboard event, and assert the engine observably reacted. The unit
// tests (map-camera-api.test.ts) pin the math/routing in isolation; this
// spec proves the wiring survives the real rAF loop + real DOM canvas.
//
// Uses the `minimal` demo (single inline-GeoJSON source, no network
// tiles) so `idle` settles deterministically without tile-fetch flake.

import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/** Navigate to the minimal demo and wait for the engine to enter the
 *  render loop (`__xgisReady` is set on the first rendered frame, the
 *  same frame `load` fires). */
async function gotoReady(page: Page): Promise<void> {
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
}

test.describe('P0-8 lifecycle/camera events + P0-7 keyboard a11y (live GPU)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 })
  })

  test('load/move*/zoom*/idle fire; ArrowRight moves camera; a11y attrs present', async ({ page }) => {
    test.setTimeout(60_000)
    await gotoReady(page)

    // ── Register listeners on the live map BEFORE driving it. We attach
    //    in-page (the engine lives in the page context) and accumulate
    //    fired event names + the center BEFORE/AFTER the keyboard pan.
    await page.evaluate(() => {
      const w = window as unknown as {
        __xgisMap: {
          on(t: string, h: (e?: unknown) => void): void
          jumpTo(o: { center?: [number, number]; zoom?: number }): void
          getCenter(): [number, number]
        }
        __evt: Record<string, number>
      }
      const map = w.__xgisMap
      const counts: Record<string, number> = {}
      const bump = (t: string) => () => { counts[t] = (counts[t] ?? 0) + 1 }
      for (const t of ['movestart', 'move', 'moveend', 'zoomstart', 'zoom', 'zoomend', 'idle']) {
        map.on(t, bump(t))
      }
      w.__evt = counts
    })

    // `load` already fired on the first frame (before our listeners could
    // attach), so assert it via a fresh `on('load')` — the production
    // contract is that a late `on('load')` does NOT retro-fire (MapLibre
    // fires load once, at first render). We instead prove load fired by
    // a separate signal: the engine sets `__xgisReady` in the SAME code
    // path that calls `_fireLoadEvent()`. To directly prove the event bus
    // delivers `load`, we re-navigate with the listener attached at the
    // earliest possible moment below.

    // ── Drive a programmatic camera change → expect a full move + zoom
    //    cycle. Target a low-zoom, well-covered region ([0,0] z2) so the
    //    scene converges (no perpetual tile-fetch / flicker), letting
    //    `idle` re-arm afterwards. (z=0 → z=2 makes zoom* fire too.)
    await page.evaluate(() => {
      ;(window as unknown as { __xgisMap: { jumpTo(o: { center: [number, number]; zoom: number }) : void } })
        .__xgisMap.jumpTo({ center: [0, 0], zoom: 2 })
    })
    // Wait until the busy→idle transition fires AGAIN (idle count climbs
    // past the initial-load idle). This both (a) proves moveend/zoomend
    // closed out and (b) proves idle re-arms after a move. Generous
    // timeout: the scene must actually converge, which depends on the GPU.
    await page.waitForFunction(
      () => ((window as unknown as { __evt: Record<string, number> }).__evt.moveend ?? 0) >= 1
         && ((window as unknown as { __evt: Record<string, number> }).__evt.idle ?? 0) >= 1,
      null, { timeout: 25_000 },
    )

    const counts = await page.evaluate(
      () => (window as unknown as { __evt: Record<string, number> }).__evt,
    )

    // moveend after jumpTo (the headline P0-8 fix).
    expect(counts.movestart ?? 0, 'movestart fired').toBeGreaterThanOrEqual(1)
    expect(counts.move ?? 0, 'move fired').toBeGreaterThanOrEqual(1)
    expect(counts.moveend ?? 0, 'moveend fired after jumpTo').toBeGreaterThanOrEqual(1)
    // jumpTo changed zoom 0→2, so zoom* must fire too.
    expect(counts.zoomstart ?? 0, 'zoomstart fired').toBeGreaterThanOrEqual(1)
    expect(counts.zoom ?? 0, 'zoom fired').toBeGreaterThanOrEqual(1)
    expect(counts.zoomend ?? 0, 'zoomend fired after zoom change').toBeGreaterThanOrEqual(1)
    // idle fires once the camera is at rest and there is no pending work.
    expect(counts.idle ?? 0, 'idle fired when settled').toBeGreaterThanOrEqual(1)

    // ── P0-7 a11y attributes on the live DOM canvas.
    const a11y = await page.evaluate(() => {
      const map = (window as unknown as {
        __xgisMap: { getCanvas(): HTMLCanvasElement }
      }).__xgisMap
      const c = map.getCanvas()
      return {
        tabindex: c.getAttribute('tabindex'),
        role: c.getAttribute('role'),
        ariaLabel: c.getAttribute('aria-label'),
        hasKeydownMarker: c.hasAttribute('data-xgis-map'),
      }
    })
    expect(a11y.tabindex, 'canvas tabindex').toBe('0')
    expect(a11y.role, 'canvas role').toBeTruthy()
    expect(a11y.ariaLabel, 'canvas aria-label').toBeTruthy()
    expect(a11y.hasKeydownMarker, 'focus-ring marker present').toBe(true)

    // ── P0-7 keyboard pan: focus the canvas, dispatch ArrowRight, assert
    //    the center CHANGED. We read center before/after around a real
    //    keydown delivered through the DOM (page.keyboard requires focus).
    const before = await page.evaluate(
      () => (window as unknown as { __xgisMap: { getCenter(): [number, number] } }).__xgisMap.getCenter(),
    )
    // Focus the canvas element (it is focusable via tabindex=0).
    await page.evaluate(() => {
      (window as unknown as { __xgisMap: { getCanvas(): HTMLCanvasElement } }).__xgisMap.getCanvas().focus()
    })
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(500)
    const after = await page.evaluate(
      () => (window as unknown as { __xgisMap: { getCenter(): [number, number] } }).__xgisMap.getCenter(),
    )
    const moved = Math.abs(after[0] - before[0]) > 1e-9 || Math.abs(after[1] - before[1]) > 1e-9
    expect(moved, `ArrowRight changed center: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`).toBe(true)
  })

  test('load fires once, delivered to a listener attached at construction time', async ({ page }) => {
    test.setTimeout(60_000)
    // Attach the `load` listener as early as possible: poll for __xgisMap
    // existence (set synchronously in the ctor, BEFORE run()/load) and
    // register before the first frame. Proves the event bus delivers
    // `load` exactly once.
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      const w = window as unknown as {
        __xgisMap?: { on(t: string, h: () => void): void }
        __loadCount?: number
      }
      w.__loadCount = 0
      const tryAttach = () => {
        if (w.__xgisMap) {
          w.__xgisMap.on('load', () => { w.__loadCount = (w.__loadCount ?? 0) + 1 })
          return true
        }
        return false
      }
      if (!tryAttach()) {
        const iv = setInterval(() => { if (tryAttach()) clearInterval(iv) }, 5)
        // Safety stop.
        setTimeout(() => clearInterval(iv), 20_000)
      }
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 },
    )
    await page.waitForTimeout(1000)
    const loadCount = await page.evaluate(
      () => (window as unknown as { __loadCount?: number }).__loadCount ?? -1,
    )
    expect(loadCount, 'load fired exactly once').toBe(1)
  })
})
