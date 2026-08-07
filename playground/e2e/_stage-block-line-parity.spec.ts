// ═══ §5 render gate for line stage blocks (#1605 Phase 1): @stroke ≡ utility twin ═══
//
// fixture_stage_line_color authors the line's stroke colour directly as
// `@stroke { return vec4(0.8, 0.4, 0.2, 1) }`; fixture_stage_line_color_twin
// writes the same colour the ordinary way (`stroke-#cc6633`, the exact 8-bit
// round-trip of the same vec4). Mirrors _stage-block-parity.spec.ts (#1538,
// polygon fill) — same harness, same hash-equality verdict.
//
// IMPORTANT SCOPE NOTE: this constant body is CPU-folded by
// foldStageConstantRgba (compiler/src/ir/to-property-shape.ts) and renders
// through the ordinary default-uniform path on EITHER backend — it does
// NOT exercise the new WGSL composer seam in map/src/shaders/dsl/line.ts at
// all (both backends hit the same folded-hex path regardless of the
// composer). This gate only proves "a constant @stroke on a line layer
// still renders correctly, nothing crashed" — a real regression guard, but
// not proof the seam works. The fixture that actually proves the seam is
// fixture-stage-line-color-zoom.xgis (a zoom-driven, non-foldable body),
// which is WebGPU-only and — per CLAUDE.md §5, no software WebGPU adapter
// in this sandbox — genuinely cannot be a headless CI gate. It is verified
// manually: `HEADED=1` locally on real WebGPU hardware, comparing the
// rendered stroke colour at two zooms against the hand-computed
// vec4(zoom/22, 0.2, 0.1, 1) expectation (compare-parity-pixeldiff /
// tile-crop-review skills). State this plainly rather than silently
// skipping GPU verification of the seam itself.
//
// Backend PINNED to WebGL2 (`?backend=webgl2`) and asserted via the live
// #backend-tag; `&adaptive=0` pins the adaptive quality controller off
// (same settle-race rationale as _stage-block-parity.spec.ts's header).

import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureCanvas } from './helpers/visual'

const ART = join(process.cwd(), 'test-results', 'stage-block-line-parity')

interface PixelStats {
  hash: string
  nonBg: number
  total: number
}

function pixelStats(png: Buffer): PixelStats {
  const img = PNG.sync.read(png)
  const data = img.data
  // Scene-region crop, matching the sibling #1538 gate — excludes the demo
  // chrome (description strip, log panel, toolbar), which differs per
  // fixture by design and is not render output.
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
  await page.goto(`/demo.html?id=${id}&backend=webgl2&e2e=1&ptdur=0&fade=0&adaptive=0`, {
    waitUntil: 'domcontentloaded',
  })
  await expect(page.locator('#backend-tag')).toHaveText('WebGL2', { timeout: 30_000 })
  // Self-stabilizing capture — same idiom as the sibling #1538 gate: the
  // engine renders on demand, so a fixed wait is not a settle criterion.
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

test('@stroke stage block on a line layer renders pixel-identical to its utility twin (webgl2)', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const stageScene = await captureScene(page, 'fixture_stage_line_color')
  const twin = await captureScene(page, 'fixture_stage_line_color_twin')

  // Non-vacuous floor: the line spans 80° at the default camera with a
  // 16px stroke — far more than 500 non-background pixels on any viewport
  // this suite uses.
  expect(stageScene.nonBg, 'stage-block line scene rendered blank').toBeGreaterThan(500)
  expect(twin.nonBg, 'utility twin rendered blank').toBeGreaterThan(500)

  // The verdict: hash equality across the two programs.
  expect(stageScene.hash, `nonBg stage=${stageScene.nonBg} twin=${twin.nonBg}`).toBe(twin.hash)
})
