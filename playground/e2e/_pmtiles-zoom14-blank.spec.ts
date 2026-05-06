// Regression spec for "PMTiles starts blank when initial zoom is 14".
//
// Symptom: load `/demo.html?id=pmtiles_layered#14/35.68/139.76` and
// the canvas stays the background colour (stone-100 ≈ #f5f5f4) even
// after the page is "ready" — no roads, water, landuse, or buildings
// composite onto the visible frame. Lower starting zooms (e.g. 3)
// render correctly, so the bug is specific to high-zoom cold start.
//
// Detection: count pixels that differ from the demo's background
// fill. A correctly-rendered Tokyo at z=14 paints water + roads +
// landuse + buildings across most of the viewport, so the non-
// background ratio comfortably clears 5 %. The blank-canvas
// regression sits at ~0 %.

import { test, expect } from '@playwright/test'

test.describe('PMTiles cold-start at high zoom', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('pmtiles_layered: zoom=14 cold start renders non-blank canvas', async ({ page }) => {
    test.setTimeout(60_000)

    await page.goto(
      `/demo.html?id=pmtiles_layered#14/35.68/139.76`,
      { waitUntil: 'domcontentloaded' },
    )

    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 },
    )

    // Generous settle window — at z=14 the archive directory has to
    // page through several levels before the visible tiles' bytes
    // are reachable. 15 s is well past the worst-case observed cold-
    // start time on a correctly-functioning load.
    await page.waitForTimeout(15_000)

    // Sample the canvas. WebGPU surface is an HTMLCanvasElement and
    // drawImage works against it cross-context, so we copy into a 2D
    // canvas and read pixels through getImageData.
    const stats = await page.evaluate(() => {
      const canvas = document.querySelector('#xgis-canvas') as HTMLCanvasElement | null
        ?? document.querySelector('canvas') as HTMLCanvasElement
      const w = canvas.width
      const h = canvas.height
      const tmp = document.createElement('canvas')
      tmp.width = w
      tmp.height = h
      const ctx = tmp.getContext('2d')!
      ctx.drawImage(canvas, 0, 0)
      const data = ctx.getImageData(0, 0, w, h).data
      // stone-100 ≈ rgb(245, 245, 244) — the demo's `background`
      // fill. Anything within ±6 of that on each channel counts as
      // "still showing background, no tile painted here".
      let bg = 0, fg = 0
      const total = data.length / 4
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2]
        if (Math.abs(r - 245) <= 6 && Math.abs(g - 245) <= 6 && Math.abs(b - 244) <= 6) {
          bg++
        } else {
          fg++
        }
      }
      // Also gather VTR diagnostic state for the failure report —
      // helps distinguish "tiles rendered but invisible" from "no
      // tiles rendered" if this ever flakes.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = (window as any).__xgisMap
      const vtrs: Array<{ name: string; tilesVisible: number; drawCalls: number; gpu: number }> = []
      if (map?.vtSources) {
        for (const [name, entry] of map.vtSources.entries()) {
          const ds = entry.renderer.getDrawStats?.() ?? {}
          vtrs.push({
            name,
            tilesVisible: ds.tilesVisible ?? 0,
            drawCalls: ds.drawCalls ?? 0,
            gpu: entry.renderer.getCacheSize?.() ?? 0,
          })
        }
      }
      return { bg, fg, total, fgPct: fg / total, vtrs }
    })

    console.log(`[zoom14-blank] fg=${stats.fg} bg=${stats.bg} total=${stats.total} fgPct=${(stats.fgPct * 100).toFixed(2)}%`)
    for (const v of stats.vtrs) {
      console.log(`  ${v.name}: tilesVisible=${v.tilesVisible} drawCalls=${v.drawCalls} gpu=${v.gpu}`)
    }

    // The pure-blank failure mode is "canvas stays white, VTR draws
    // nothing". A correctly rendering frame has tilesVisible > 0 AND
    // drawCalls > 0 across at least one VTR. Pixel-only check would
    // miss the "draws background but no tiles" sub-case (canvas is
    // stone-100, fgPct=0); the VTR-stats check catches both.
    const totalVisible = stats.vtrs.reduce((s, v) => s + v.tilesVisible, 0)
    const totalDraws = stats.vtrs.reduce((s, v) => s + v.drawCalls, 0)
    expect.soft(totalVisible).toBeGreaterThan(0)
    expect.soft(totalDraws).toBeGreaterThan(0)
    // And tile pixels must actually composite onto the visible frame
    // — Tokyo at z=14 with 4 layers fills more than 10 % of the
    // viewport with non-background colour.
    expect(stats.fgPct).toBeGreaterThan(0.10)
  })
})
