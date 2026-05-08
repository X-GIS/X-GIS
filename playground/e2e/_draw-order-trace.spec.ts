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
    __xgisDrawOrderResult?: Array<{
      seq: number; slice: string; phase: string; extrude: string
      tileKey?: number; isFill?: boolean
    }>
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

    const events = trace ?? []
    // eslint-disable-next-line no-console
    console.log('Captured', events.length, 'draw events. Summary by slice:')
    const bySlice = new Map<string, { extrude: string; tiles: number[] }>()
    for (const e of events) {
      const cur = bySlice.get(e.slice) ?? { extrude: e.extrude, tiles: [] }
      if (e.isFill && typeof e.tileKey === 'number') cur.tiles.push(e.tileKey)
      bySlice.set(e.slice, cur)
    }
    for (const [slice, info] of bySlice) {
      // eslint-disable-next-line no-console
      console.log(`  slice="${slice}" extrude=${info.extrude} tileFills=${info.tiles.length}`)
    }
    writeFileSync('draw-order-trace.json', JSON.stringify(events, null, 2))

    // The user's concern, precisely stated:
    //   The CORRECT order is "all-tiles 2D, then all-tiles 3D":
    //     for tile in tiles: tile.draw2D     (bucket 1)
    //     for tile in tiles: tile.draw3D     (bucket 2)
    //   The BROKEN order would be "per-tile 2D+3D interleaved":
    //     for tile in tiles: tile.draw2D + tile.draw3D
    //
    // Per-tile drawIndexed events let us check this directly:
    // every entry with extrude='none' (2D) must have a sequence
    // index BELOW every entry with extrude='feature'/'uniform' (3D).
    // If we ever see [..., 3D fill at tile X, ..., 2D fill at tile Y, ...]
    // the assertion below fires and prints the violation.
    let lastNoneFillSeq = -1
    let firstExtrudedFillSeq = -1
    const violations: typeof events = []
    for (const e of events) {
      if (!e.isFill) continue
      if (e.extrude === 'none') {
        if (firstExtrudedFillSeq >= 0) violations.push(e)
        lastNoneFillSeq = e.seq
      } else {
        if (firstExtrudedFillSeq < 0) firstExtrudedFillSeq = e.seq
      }
    }
    // eslint-disable-next-line no-console
    console.log(`lastNoneFillSeq=${lastNoneFillSeq} firstExtrudedFillSeq=${firstExtrudedFillSeq} violations=${violations.length}`)
    if (violations.length > 0) {
      // eslint-disable-next-line no-console
      console.log('Violations (2D fill AFTER 3D fill started):', violations)
    }
    expect(violations.length).toBe(0)
    expect(firstExtrudedFillSeq).toBeGreaterThan(lastNoneFillSeq)
  })
})
