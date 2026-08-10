// ═══ Translucent stroke renders on the WebGPU chain (#1046 Inc-2d F1's named gate) ═══
//
// THE GAP THIS CLOSES. Inc-2d retyped the translucent SCC (offscreen MAX-blend
// + fullscreen composite) onto the RHI frame shell, and its review found F1
// CRITICAL: the offscreen pass ran `rgba8unorm` on the twin while the max-blend
// composite pipeline was built for the CANVAS format — on WebGPU that class of
// format mismatch is a VALIDATION KILL: every SetPipeline errors, the layer
// silently never draws, and no unit test sees it (recorders accept any
// descriptor — the pipeline-that-was-right-somewhere-else lesson). The fix made
// `LINE_OFFSCREEN_FORMAT` the one authority; THIS is the regression fence the
// F1 review named and no CI leg ran: a real device must actually rasterise a
// translucent stroke through the chain.
//
// THE GATE. fixture_translucent_outline (zero-network): an inset amber-300
// stroke at layer opacity 0.6 over an opaque slate-800 base blends to
// ≈ rgb(166,143,70) — background-independent by fixture construction (the
// stroke band lies entirely over the layer's own fill). A painted blended band
// IS the gate: the F1 failure class presents the base fill with NO band (the
// translucent bucket's draws validation-killed), and the historical opaque
// double-draw regression presents FULL amber (252,211,77) — both far outside
// the mask. Same colour model as `_translucent-outline-parity` (local A/B).
//
// Headless SwiftShader WebGPU (HEADED=0 XGIS_SOFTWARE_GPU=1) — the chain arm.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__render-verify__')

test('translucent outline blends through the chain (fixture_translucent_outline)', async ({
  page,
}) => {
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto('/demo.html?id=fixture_translucent_outline&e2e=1', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )

  // 0.6·amber-300 + 0.4·slate-800 ≈ (166,143,70), tol 35 — excludes both the
  // bare slate-800 fill (band missing = the F1 class) and the full-amber
  // opaque double-draw (Δred ≈ 86).
  const countBlended = (png: PNG): number => {
    let n = 0
    for (let p = 0; p < png.width * png.height; p++) {
      const i = p * 4
      if (
        Math.abs(png.data[i]! - 166) < 35 &&
        Math.abs(png.data[i + 1]! - 143) < 35 &&
        Math.abs(png.data[i + 2]! - 70) < 35
      )
        n++
    }
    return n
  }

  // Poll until the tile decodes + the translucent composite lands (SwiftShader
  // settle contract, as the fills/labels gates).
  let png = PNG.sync.read(await page.locator('#map').screenshot({ type: 'png' }))
  let blended = countBlended(png)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && blended <= 2000) {
    await page.evaluate(() => {
      ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    })
    await page.waitForTimeout(2000)
    png = PNG.sync.read(await page.locator('#map').screenshot({ type: 'png' }))
    blended = countBlended(png)
  }
  writeFileSync(join(OUT, 'translucent-chain-gate.png'), PNG.sync.write(png))

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
    `[translucent-chain] marker=${state.marker} blended=${blended} ` +
      `dims=${png.width}x${png.height} errors=${errors.length}`,
  )

  // The chain arm, not a fallback — and no validation kill (the F1 signature).
  expect(state.marker, 'default backend resolved to the WebGPU chain').toBe('webgpu')
  expect(state.validation, 'no GPU validation errors').toEqual([])
  expect(errors, 'no page/console errors').toEqual([])

  // THE GATE: the blended translucent band actually rasterised.
  expect(
    blended,
    `blended-stroke pixels ${blended} — 0 here is the F1 class (translucent draws validation-killed)`,
  ).toBeGreaterThan(2000)
})
