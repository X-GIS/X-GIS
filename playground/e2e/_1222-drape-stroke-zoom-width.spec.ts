// #1222 — baked-tile drape strokes must keep CONSTANT SCREEN-PX width under
// continuous camera zoom.
//
// The bug: the globe drape bakes strokes into tile textures at a fixed bakeMpp
// (correct only where one bake texel ≈ one screen px), and the bake cache key
// carries no camera zoom — so within a tile level the magnified texture scales
// the stroke width with the camera (snapping back at each pyramid switch).
//
// The fix (zoom-bucketed rebake) folds a quarter-zoom bucket of
// (camZoom − tileZ) into the bake invalidation and scales the baked widthPx by
// 2^(tileZ − camZoom), holding the on-screen width within ±~9 % of the style
// contract at any camera zoom.
//
// Measurement: an inline globe scene with three long stroke-8 amber parallels;
// at three camera zooms the median vertical run of amber pixels per column is
// the on-screen stroke width. Pre-fix the width grows ~2^Δz between bucket
// steps (8 px → ~11 px over Δz 0.45); post-fix all three zooms measure the
// same width within tolerance. Headless SwiftShader WebGPU (the bake path).

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '__1222-drape-width__')

const SRC = `xgis 1

source parallels {
  type: geojson
  data: { "type": "FeatureCollection", "features": [
    { "type": "Feature", "geometry": { "type": "LineString", "coordinates": [[-60,-20],[-30,-20],[0,-20],[30,-20],[60,-20]] }, "properties": {} },
    { "type": "Feature", "geometry": { "type": "LineString", "coordinates": [[-60,0],[-30,0],[0,0],[30,0],[60,0]] }, "properties": {} },
    { "type": "Feature", "geometry": { "type": "LineString", "coordinates": [[-60,20],[-30,20],[0,20],[30,20],[60,20]] }, "properties": {} }
  ] }
}

layer bands {
  source: parallels
  | stroke-amber-500 stroke-8
}
`

const ZOOMS = [2.0, 2.45, 2.9]

type Win = Window & {
  __xgisReady?: boolean
  __xgisMap?: {
    invalidate?: () => void
    markCameraPositioned?: () => void
    getCamera?: () => {
      zoom: number
      maxZoom: number
      projType?: number
      globeMode?: boolean
    }
    ctx?: { rhi?: { backend?: string } }
    getTileLoadDiagnostic?: () => Record<string, { catalogLoading: number; uploadQueued: number }>
  }
}

async function setZoomAndSettle(
  page: import('@playwright/test').Page,
  zoom: number,
): Promise<void> {
  await page.evaluate((z) => {
    const m = (window as unknown as Win).__xgisMap!
    const c = m.getCamera!()
    c.zoom = Math.max(0, Math.min(c.maxZoom, z))
    m.markCameraPositioned?.()
    m.invalidate?.()
  }, zoom)
  await page
    .waitForFunction(
      () => {
        const m = (window as unknown as Win).__xgisMap
        if (!m?.getTileLoadDiagnostic) return true
        m.invalidate?.()
        const d = m.getTileLoadDiagnostic()
        let n = 0
        for (const k in d) n += d[k]!.catalogLoading + d[k]!.uploadQueued
        return n === 0
      },
      null,
      { timeout: 30_000 },
    )
    .catch(() => {})
  await page.waitForTimeout(1_800)
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

test('#1222 drape stroke width stays constant px across camera zoom', async ({ page }) => {
  test.setTimeout(300_000)
  mkdirSync(OUT, { recursive: true })
  await page.setViewportSize({ width: 1100, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

  const src = Buffer.from(SRC, 'utf8').toString('base64')
  await page.goto(`/demo.html?id=__import&e2e=1&proj=globe#src=${src}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 30_000,
  })

  const backend = await page.evaluate(
    () => (window as unknown as Win).__xgisMap?.ctx?.rhi?.backend ?? 'unknown',
  )
  test.skip(backend !== 'webgpu', `drape bake is WebGPU-only (got ${backend})`)

  const widths: number[] = []
  for (const z of ZOOMS) {
    await setZoomAndSettle(page, z)
    const png = await page.locator('#map').screenshot()
    writeFileSync(join(OUT, `z${z.toFixed(2)}.png`), png)

    // Median vertical amber-run per column = on-screen stroke width. Runs are
    // collected only in the central band (the parallels are near-horizontal
    // there; at the limb the slope inflates a vertical run).
    const m = await page.evaluate(
      async ({ b64 }) => {
        const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
        const bmp = await createImageBitmap(blob)
        const c = document.createElement('canvas')
        c.width = bmp.width
        c.height = bmp.height
        const ctx = c.getContext('2d')!
        ctx.drawImage(bmp, 0, 0)
        const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
        const x0 = Math.floor(bmp.width * 0.35)
        const x1 = Math.floor(bmp.width * 0.65)
        const runs: number[] = []
        for (let x = x0; x < x1; x++) {
          let run = 0
          for (let y = 0; y < bmp.height; y++) {
            const i = (y * bmp.width + x) * 4
            const r = d[i]
            const g = d[i + 1]
            const b = d[i + 2]
            // amber-500 #f59e0b
            const isStroke = r > 200 && g > 110 && g < 200 && b < 90
            if (isStroke) run++
            else {
              if (run >= 2 && run <= 60) runs.push(run)
              run = 0
            }
          }
          if (run >= 2 && run <= 60) runs.push(run)
        }
        runs.sort((a, b) => a - b)
        return {
          median: runs.length ? runs[Math.floor(runs.length / 2)]! : 0,
          samples: runs.length,
        }
      },
      { b64: png.toString('base64') },
    )
    console.log(`ZOOM ${z}: medianWidth=${m.median}px samples=${m.samples}`)
    expect(m.samples, `zoom ${z}: stroke visible`).toBeGreaterThan(50)
    widths.push(m.median)
  }

  const wMin = Math.min(...widths)
  const wMax = Math.max(...widths)
  console.log(`WIDTHS ${JSON.stringify(widths)} ratio=${(wMax / wMin).toFixed(3)}`)
  expect(errors, 'no page errors').toEqual([])
  // Constant-px contract: quarter-zoom bucketing bounds the drift at 2^(1/8)
  // ≈ ±9 %; +1 px covers AA. Pre-fix the 0.9-zoom sweep measures ~2^0.9 ≈ 1.87×.
  expect(wMax / wMin, `stroke width ${JSON.stringify(widths)} must stay constant px`).toBeLessThan(
    1.25,
  )
})
