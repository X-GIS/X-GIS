// ═══ Labels render on the WebGPU chain (#1046 Inc-2e) — SwiftShader probe/gate ═══
//
// The twin side has `_labels-gl2-gate` in CI (multiline_labels, zero-network:
// in-page GeoJSON push, glyphs SDF-baked in-browser). The CHAIN side (the
// label pass through `requireRhiFrame` since Inc-2e) had no pixel check on any
// backend CI can drive. This is the same gate on the DEFAULT backend: white
// glyph cores (#fff text, #000 halo) counted from the composited frame.
//
// PROBE CAVEAT (#1046 Inc-4b): whether SwiftShader-WebGPU rasterises the
// r8unorm glyph-atlas sample path on the CI container is exactly what the
// first run of this spec measures. If it holds, this gates labels+icons on
// the chain; a 0-white result would be documented here and the spec kept
// OFF the CI list (the desktop-WebGPU frame — ADR-0004's pending view —
// then remains the only full-fidelity label check).
//
// Headless SwiftShader WebGPU (HEADED=0 XGIS_SOFTWARE_GPU=1) — the chain arm.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__render-verify__')

test('multiline labels render on the WebGPU chain', async ({ page }) => {
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.goto('/demo.html?id=multiline_labels&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )

  // ?e2e=1 opts out of the demo-runner's auto data push — push the labelled
  // cities ourselves (same three as the gl2 gate).
  await page.evaluate(() => {
    ;(
      window as unknown as {
        __xgisMap?: { setSourceData?: (id: string, fc: unknown) => void }
      }
    ).__xgisMap?.setSourceData?.('cities', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-74, 40.7] },
          properties: { name: 'New York City' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [2.35, 48.85] },
          properties: { name: 'Paris Metropolitan Area' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [139.69, 35.68] },
          properties: { name: 'Tokyo Special Wards' },
        },
      ],
    })
  })

  const countWhite = (png: PNG): number => {
    let n = 0
    for (let p = 0; p < png.width * png.height; p++) {
      const i = p * 4
      if (png.data[i]! > 230 && png.data[i + 1]! > 230 && png.data[i + 2]! > 230) n++
    }
    return n
  }

  // Poll until glyph rasterization + atlas upload settle — the gl2 gate's
  // polling contract, read from the composited frame (no gl on this backend).
  let png = PNG.sync.read(await page.locator('#map').screenshot({ type: 'png' }))
  let white = countWhite(png)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && white <= 80) {
    await page.evaluate(() => {
      ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    })
    await page.waitForTimeout(2000)
    png = PNG.sync.read(await page.locator('#map').screenshot({ type: 'png' }))
    white = countWhite(png)
  }
  writeFileSync(join(OUT, 'labels-chain-gate.png'), PNG.sync.write(png))

  const state = await page.evaluate(() => {
    const w = window as unknown as {
      __xgisActiveBackend?: string
      __xgisMap?: { ctx?: { _validationErrors?: { message: string }[] } }
    }
    return {
      marker: w.__xgisActiveBackend,
      validation: (w.__xgisMap?.ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
    }
  })
  console.log(
    `[labels-chain] marker=${state.marker} white=${white} dims=${png.width}x${png.height} ` +
      `errors=${errors.length}`,
  )

  expect(state.marker, 'default backend resolved to the WebGPU chain').toBe('webgpu')
  expect(state.validation, 'no GPU validation errors').toEqual([])
  expect(errors, 'no page/console errors').toEqual([])

  // Same floor as the gl2 gate: glyph cores are sparse but a blank frame or
  // halo-only smear stays near 0.
  expect(white, `white label pixels ${white}`).toBeGreaterThan(80)
})
