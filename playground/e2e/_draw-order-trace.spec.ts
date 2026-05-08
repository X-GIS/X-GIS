// Verify that 3D extruded shows are actually drawn LAST in the GPU
// command stream — not just declared last in the style. The user's
// reported bug ("back tile through front") at high pitch could be
// either a depth-test issue or a draw-order issue, and the previous
// architectural argument ("buildings is the last show, so it's drawn
// last") is paper analysis. This spec captures the runtime trace.

import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'

declare global {
  interface Window {
    __xgisCaptureDrawOrder?: boolean
    __xgisDrawOrderResult?: Array<{ seq: number; slice: string; phase: string; extrude: string }>
  }
}

test.describe('VTR draw order at high pitch', () => {
  test('osm_style Seoul z=15.78 pitch=85° — buildings drawn after ground', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 430, height: 715 })
    await page.goto('/demo.html?id=osm_style&e2e=1#15.78/37.53155/126.97068/348.1/85.0', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => window.__xgisReady === true, null, { timeout: 30_000 })
    await page.waitForTimeout(15_000) // tiles to settle

    // Arm one-frame capture, then nudge the canvas with a tiny pan so
    // the render loop wakes (idle camera doesn't redraw).
    await page.evaluate(() => { window.__xgisCaptureDrawOrder = true })
    const map = page.locator('#map')
    const box = await map.boundingBox()
    if (!box) throw new Error('no map bounds')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 1, cy + 1)
    await page.mouse.up()
    await page.waitForFunction(() => Array.isArray(window.__xgisDrawOrderResult), null, { timeout: 10_000 })
    const trace = await page.evaluate(() => window.__xgisDrawOrderResult)

    // eslint-disable-next-line no-console
    console.log('Captured', (trace ?? []).length, 'draw calls. Order:')
    for (const e of trace ?? []) {
      // eslint-disable-next-line no-console
      console.log(`  seq=${e.seq}  extrude=${e.extrude.padEnd(10)}  phase=${e.phase.padEnd(8)}  slice="${e.slice}"`)
    }
    writeFileSync('draw-order-trace.json', JSON.stringify(trace, null, 2))

    // Two diagnostic invariants:
    //   1. At least one extruded show fired (buildings layer is in
    //      osm_style — if this fails, something stopped sending it
    //      through VTR.render).
    //   2. EVERY non-extruded ('none') show appears BEFORE every
    //      extruded show. If false → 2D ground draws after 3D
    //      buildings → 3D buildings get painted over by ground →
    //      visible "back through front" artifact even with depth
    //      working correctly.
    const hasExtruded = (trace ?? []).some(e => e.extrude !== 'none')
    const lastNoneIdx = (trace ?? []).reduce(
      (acc, e, i) => e.extrude === 'none' ? i : acc, -1)
    const firstExtrudedIdx = (trace ?? []).findIndex(e => e.extrude !== 'none')
    // eslint-disable-next-line no-console
    console.log(`hasExtruded=${hasExtruded} lastNoneIdx=${lastNoneIdx} firstExtrudedIdx=${firstExtrudedIdx}`)

    expect(hasExtruded).toBe(true)
    expect(firstExtrudedIdx).toBeGreaterThan(lastNoneIdx)
  })
})
