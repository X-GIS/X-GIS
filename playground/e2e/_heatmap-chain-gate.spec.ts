// ═══ Heatmap renders its density blob on the WebGPU chain (#1046 Inc-2c) ═══
//
// THE GAP THIS CLOSES. Inc-2c re-originated the whole heatmap vertical —
// accum Gaussian splat → separable blur → density→colour compose — through
// the RHI drapers, retiring the native 4-pass block. The twin side has
// `_heatmap-gl2-gate` in CI, but the CHAIN side's only check was the local
// `_heatmap-verify`, which asserts CPU state (points survived tiling, the
// renderer holds a layer) and reads back NO pixels — a compose that
// validation-dies or draws nothing keeps it green. This spec promotes that
// pattern to a pixel gate on the default backend.
//
// THE GATE. The heatmap demo (zero-egress: vendored Natural Earth GeoJSON
// under the dev server) splats 243 populated places over a slate-800/900
// basemap. The compose's colour ramp is VIVID where the slate base is
// desaturated, so the blob is counted by CHROMA (max−min channel spread):
// slate pixels sit < 25, ramp pixels far above. A dead accum/blur/compose
// collapses the count to ~0 — CPU state stays green, this does not.
//
// Headless SwiftShader WebGPU (HEADED=0 XGIS_SOFTWARE_GPU=1) — the chain arm.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__render-verify__')

test('heatmap density blob rasterises through the chain', async ({ page }) => {
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.setViewportSize({ width: 1200, height: 700 })
  await page.goto('/demo.html?id=heatmap&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )

  // Chroma = max−min channel: the slate basemap is near-achromatic; the
  // density ramp is saturated. 60 clears anti-aliased coastline noise.
  const countVivid = (png: PNG): number => {
    let n = 0
    for (let p = 0; p < png.width * png.height; p++) {
      const i = p * 4
      const r = png.data[i]!,
        g = png.data[i + 1]!,
        b = png.data[i + 2]!
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) n++
    }
    return n
  }

  // Poll until the GeoJSON tiles + the 3-pass heatmap settle (SwiftShader).
  let png = PNG.sync.read(await page.locator('#map').screenshot({ type: 'png' }))
  let vivid = countVivid(png)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && vivid <= 3000) {
    await page.evaluate(() => {
      ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    })
    await page.waitForTimeout(2000)
    png = PNG.sync.read(await page.locator('#map').screenshot({ type: 'png' }))
    vivid = countVivid(png)
  }
  writeFileSync(join(OUT, 'heatmap-chain-gate.png'), PNG.sync.write(png))

  const state = await page.evaluate(() => {
    const w = window as unknown as {
      __xgisActiveBackend?: string
      __xgisMap?: {
        ctx?: { _validationErrors?: { message: string }[] }
        heatmapRenderer?: { layers?: unknown[] } | null
      }
    }
    return {
      marker: w.__xgisActiveBackend,
      validation: (w.__xgisMap?.ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
      heatmapLayers: w.__xgisMap?.heatmapRenderer?.layers?.length ?? 0,
    }
  })
  console.log(
    `[heatmap-chain] marker=${state.marker} layers=${state.heatmapLayers} vivid=${vivid} ` +
      `dims=${png.width}x${png.height} errors=${errors.length}`,
  )

  expect(state.marker, 'default backend resolved to the WebGPU chain').toBe('webgpu')
  expect(state.validation, 'no GPU validation errors').toEqual([])
  expect(errors, 'no page/console errors').toEqual([])
  // Right-reason guard (the _heatmap-verify CPU half): the layer reached the
  // renderer — so a red pixel count below means the GPU passes, not routing.
  expect(state.heatmapLayers, 'HeatmapRenderer holds the layer').toBe(1)

  // THE GATE: the density ramp actually rasterised over the slate base.
  expect(
    vivid,
    `vivid (chroma>60) pixels ${vivid} — ~0 means the accum/blur/compose drew nothing`,
  ).toBeGreaterThan(3000)
})
