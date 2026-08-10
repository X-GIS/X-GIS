// ═══ §5 render gate for user fns (#1535): fn binding ≡ hand-inlined twin ═══
//
// fixture_fn_binding authors `size-[halo(.v, 4)]` through a user `fn`;
// fixture_fn_binding_manual writes the same body by hand. Because the
// inline pass rewrites the fn call BEFORE classify/codegen, the two
// scenes must compile to the same per-feature GPU path and rasterise
// pixel-identically — the strongest rung of the render-gate ladder
// (hash equality; the harness is deterministic: fixed camera, inline
// data, software rasterizer under XGIS_SOFTWARE_GPU=1).
//
// The backend is PINNED to WebGL2 (`?backend=webgl2`) and asserted via
// the live #backend-tag so a silent fallback cannot green this spec.
// Pixels come from `locator.screenshot()` (compositor capture — an
// in-page `canvas.toBlob` reads a cleared buffer on a WebGL canvas
// without preserveDrawingBuffer) and are decoded node-side with pngjs;
// a non-background floor keeps blank-vs-blank from passing vacuously.

import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureCanvas } from './helpers/visual'

// Failure diagnosis artifacts (§5: read the image, not just the number).
const ART = join(process.cwd(), 'test-results', 'fn-binding-parity')

interface PixelStats {
  hash: string
  nonBg: number
  total: number
}

function pixelStats(png: Buffer): PixelStats {
  const img = PNG.sync.read(png)
  const data = img.data
  // Compare the SCENE region only: the demo chrome differs between the
  // two fixtures by design (per-demo description strip bottom-left, the
  // Errors/log panel bottom-right, toolbar top, drawer handle right
  // edge). The dots live well inside this crop; a diff-image read
  // confirmed the render itself is identical and every differing pixel
  // was chrome text.
  const x0 = 0
  const x1 = Math.min(img.width, 840)
  const y0 = 50
  const y1 = Math.min(img.height, 620)
  let h = 5381
  let nonBg = 0
  const r0 = data[(y0 * img.width + x0) * 4]!
  const g0 = data[(y0 * img.width + x0) * 4 + 1]!
  const b0 = data[(y0 * img.width + x0) * 4 + 2]!
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4
      h = ((h * 33) ^ data[i]!) | 0
      h = ((h * 33) ^ data[i + 1]!) | 0
      h = ((h * 33) ^ data[i + 2]!) | 0
      h = ((h * 33) ^ data[i + 3]!) | 0
      // Background = the crop-corner clear colour; the guard only needs
      // "something other than the clear colour was drawn".
      if (
        Math.abs(data[i]! - r0) > 8 ||
        Math.abs(data[i + 1]! - g0) > 8 ||
        Math.abs(data[i + 2]! - b0) > 8
      ) {
        nonBg++
      }
    }
  }
  return { hash: (h >>> 0).toString(36), nonBg, total: (x1 - x0) * (y1 - y0) }
}

async function captureScene(
  page: import('@playwright/test').Page,
  id: string,
): Promise<PixelStats> {
  // ptdur=0 + fade=0: disable paint transitions and symbol fades — the
  // documented idiom for pixel-exact screenshot gates (demo-runner.ts);
  // a mid-fade capture is the hash-flake this gate cannot afford.
  await page.goto(`/demo.html?id=${id}&backend=webgl2&e2e=1&ptdur=0&fade=0`, {
    waitUntil: 'domcontentloaded',
  })
  await expect(page.locator('#backend-tag')).toHaveText('WebGL2', { timeout: 30_000 })
  // Self-stabilizing capture: the dots scale in on load, and a
  // mid-entrance capture rings every disc in the diff (verified via a
  // diff-crop read). `elapsedMsAtLeast` is unusable here — the engine
  // renders on demand, so a static scene's `_elapsedMs` clock can stop
  // before any fixed threshold. Instead capture until two consecutive
  // frames 400ms apart hash identically: the definition of "settled".
  let png = await captureCanvas(page, { readyTimeoutMs: 30_000 })
  let stats = pixelStats(png)
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(400)
    const next = await captureCanvas(page, { readyTimeoutMs: 30_000 })
    const nextStats = pixelStats(next)
    if (nextStats.hash === stats.hash) break
    png = next
    stats = nextStats
  }
  mkdirSync(ART, { recursive: true })
  writeFileSync(join(ART, `${id}.png`), png)
  return stats
}

test('user-fn binding renders pixel-identical to its hand-inlined twin (webgl2)', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const fnScene = await captureScene(page, 'fixture_fn_binding')
  const manual = await captureScene(page, 'fixture_fn_binding_manual')

  // Non-vacuous floor: the amber dots must actually rasterise. Five
  // discs, the smallest ~6px and the largest clamped at 40px — well
  // over 500 non-background pixels on any viewport this suite uses.
  expect(fnScene.nonBg, 'fn scene rendered blank').toBeGreaterThan(500)
  expect(manual.nonBg, 'manual scene rendered blank').toBeGreaterThan(500)

  // The verdict: hash equality across the two programs.
  expect(fnScene.hash, `nonBg fn=${fnScene.nonBg} manual=${manual.nonBg}`).toBe(manual.hash)
})
