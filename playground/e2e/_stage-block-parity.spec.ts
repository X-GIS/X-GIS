// ═══ §5 render gate for stage blocks (#1538): @color ≡ utility twin ═══
//
// fixture_stage_color authors the fragment colour directly as
// `@color { return vec4(0.8, 0.4, 0.2, 1) }`; fixture_stage_color_twin
// writes the same colour the ordinary way (`fill-#cc6633`, the exact 8-bit
// round-trip of the same vec4). The escape hatch must reach the EXACT same
// pixels as the vocabulary it bypasses — the strongest rung of the
// render-gate ladder (hash equality; the harness is deterministic: fixed
// camera, inline data, software rasterizer under XGIS_SOFTWARE_GPU=1).
//
// This is the gate that proves the stage block really drives the shader:
// it lands in the same variant colour slot the utility path fills, so a
// block that silently did nothing would render the DEFAULT colour and
// diverge from the twin immediately.
//
// The backend is PINNED to WebGL2 (`?backend=webgl2`) and asserted via
// the live #backend-tag so a silent fallback cannot green this spec.
// Pixels come from `locator.screenshot()` (compositor capture — an
// in-page `canvas.toBlob` reads a cleared buffer on a WebGL canvas
// without preserveDrawingBuffer) and are decoded node-side with pngjs;
// a non-background floor keeps blank-vs-blank from passing vacuously.
//
// `&adaptive=0` pins the adaptive quality controller off. Diagnosed by
// direct probing: with it left on, the polygon-fill edge antialiasing
// settles to a DIFFERENT quality tier depending on incidental navigation
// timing (which fixture happened to load first in the page, how long the
// self-stabilizing capture loop below took to see two matching hashes) —
// not on anything either fixture authors. Two independently-tessellated,
// byte-identical-content polygons (proven by a throwaway probe fixture)
// hash-matched perfectly; the SAME pair, loaded in the opposite order,
// did not — so the mismatch was the ladder's settle race, not a render
// defect. `_adaptive-quality-ladder-gate.spec.ts` documents the ladder
// needing up to ~24s to fully settle; pinning it off is the deterministic
// fix rather than chasing that budget here.

import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureCanvas } from './helpers/visual'

// Failure diagnosis artifacts (§5: read the image, not just the number).
const ART = join(process.cwd(), 'test-results', 'stage-block-parity')

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
  // edge). The polygon lies well inside this crop; on the sibling #1535
  // gate a diff-image read confirmed every differing pixel outside it
  // was chrome text, not render output.
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
  await page.goto(`/demo.html?id=${id}&backend=webgl2&e2e=1&ptdur=0&fade=0&adaptive=0`, {
    waitUntil: 'domcontentloaded',
  })
  await expect(page.locator('#backend-tag')).toHaveText('WebGL2', { timeout: 30_000 })
  // Self-stabilizing capture: geometry animates in on load, and a
  // mid-entrance capture diverges from a settled one (diagnosed on the
  // sibling #1535 gate). `elapsedMsAtLeast` is unusable here — the engine
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

test('@color stage block renders pixel-identical to its utility twin (webgl2)', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const stageScene = await captureScene(page, 'fixture_stage_color')
  const twin = await captureScene(page, 'fixture_stage_color_twin')

  // Non-vacuous floor: the polygon must actually rasterise. It spans
  // 80° × 50° at the default camera — far more than 500 non-background
  // pixels on any viewport this suite uses.
  expect(stageScene.nonBg, 'stage-block scene rendered blank').toBeGreaterThan(500)
  expect(twin.nonBg, 'utility twin rendered blank').toBeGreaterThan(500)

  // The verdict: hash equality across the two programs.
  expect(stageScene.hash, `nonBg stage=${stageScene.nonBg} twin=${twin.nonBg}`).toBe(twin.hash)
})
