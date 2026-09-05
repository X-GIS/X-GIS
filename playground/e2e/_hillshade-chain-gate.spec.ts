// ═══ Hillshade renders shaded relief on the WebGPU chain (#1046 Inc-2a) ═══
//
// The twin side has `_hillshade-gl2-gate` in CI; the CHAIN side (HillshadePass
// originating through the RHI frame encoder since Inc-2a) had no CI pixel
// check. Same fixture, same self-calibrating metric, default backend:
// fixture_hillshade_local loads a local Terrain-RGB radial-hill DEM (offline,
// deterministic) and a real relief produces a LUMINANCE SPREAD — slopes facing
// the 335° light bright, slopes away dark — where a blank frame or a flat
// colour fill collapses to ~1 level. Readback is the composited frame (no gl
// on this backend); the alpha-skip of the gl2 gate becomes a near-black skip
// (the demo has no basemap — unpainted swapchain pixels are the clear colour).
//
// Headless SwiftShader WebGPU (HEADED=0 XGIS_SOFTWARE_GPU=1) — the chain arm.

import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__render-verify__')

async function runChainGate(page: Page, opts: { picking: boolean }): Promise<void> {
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  // The demo opens at z11 (Demo.zoom) — the DEM's Sobel deriv scale is
  // calibrated there; no test-only camera (the gl2 gate's rationale).
  const url = `/demo.html?id=fixture_hillshade_local&e2e=1${opts.picking ? '&picking=1' : ''}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )

  const measure = (png: PNG) => {
    const bins = new Array<number>(16).fill(0)
    let lit = 0
    let minL = 255
    let maxL = 0
    for (let p = 0; p < png.width * png.height; p++) {
      const i = p * 4
      const r = png.data[i]!,
        g = png.data[i + 1]!,
        b = png.data[i + 2]!
      const lum = (r * 0.299 + g * 0.587 + b * 0.114) | 0
      if (lum < 8) continue // unpainted/clear background (composited, no alpha)
      bins[Math.min(15, lum >> 4)]!++
      lit++
      if (lum < minL) minL = lum
      if (lum > maxL) maxL = lum
    }
    const nonEmptyBins = bins.filter((v) => v > lit * 0.002).length
    return { lit, nonEmptyBins, spread: lit ? maxL - minL : 0, total: png.width * png.height }
  }
  const relief = (m: { lit: number; nonEmptyBins: number; spread: number; total: number }) =>
    m.lit > m.total * 0.05 && m.nonEmptyBins >= 3 && m.spread >= 24

  // Poll until the DEM tile decodes + shades (SwiftShader settle contract).
  let png = PNG.sync.read(await page.locator('#map').screenshot({ type: 'png' }))
  let m = measure(png)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !relief(m)) {
    await page.evaluate(() => {
      ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    })
    await page.waitForTimeout(2000)
    png = PNG.sync.read(await page.locator('#map').screenshot({ type: 'png' }))
    m = measure(png)
  }
  writeFileSync(
    join(OUT, `hillshade-chain-gate${opts.picking ? '-picking' : ''}.png`),
    PNG.sync.write(png),
  )

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
    `[hillshade-chain] marker=${state.marker} lit=${m.lit}/${m.total} bins=${m.nonEmptyBins} ` +
      `spread=${m.spread} errors=${errors.length}`,
  )

  expect(state.marker, 'default backend resolved to the WebGPU chain').toBe('webgpu')
  expect(state.validation, 'no GPU validation errors').toEqual([])
  expect(errors, 'no page/console errors').toEqual([])

  // The relief signature (the gl2 gate's thresholds): lit pixels across ≥3
  // luminance levels with a real dark→light range.
  expect(m.lit, `lit pixels ${m.lit}/${m.total}`).toBeGreaterThan(m.total * 0.05)
  expect(m.nonEmptyBins, 'luminance levels present (shading structure)').toBeGreaterThanOrEqual(3)
  expect(m.spread, `dark→light luminance range ${m.spread}`).toBeGreaterThanOrEqual(24)
}

test('local raster-dem renders as shaded relief through the chain', async ({ page }) => {
  await runChainGate(page, { picking: false })
})

// #2314 — picking attaches a pick target to the opaque/oit passes but NEVER to
// the hillshade pass, which opens one colour attachment unconditionally. A
// hillshade draw that asked for the 2-target pick pipeline made Dawn reject every
// setPipeline and invalidated the frame's whole command buffer: a blank map,
// measured at 100% modal on one colour bucket. This arm is the reachability gate
// that combination never had.
test('the same chain survives GPU picking (#2314)', async ({ page }) => {
  await runChainGate(page, { picking: true })
})
