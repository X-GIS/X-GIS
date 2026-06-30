// LOCAL-ONLY WebGL2 ↔ WebGPU parity gate — NOT a CI test.
//
// CI runs an EXPLICIT spec list (.github/workflows/test.yml), so this file (not in
// that list) never runs in CI. It is an on-demand, REAL-GPU local check: it renders
// each fixture twice — once on the default WebGPU backend (the golden) and once on the
// forced WebGL2 fallback (`?forcegl2=1`) — and pixel-diffs them. Use it to track how far
// the WebGL2 render backend is from WebGPU parity as renderers get wired onto it.
//
// Run (real GPU, headed — a headless SwiftShader run does not exercise the true backends):
//   cd playground
//   XGIS_GL2_FIXTURES="fixture_raster_local,fixture_square" \
//     ./node_modules/.bin/playwright test e2e/_webgl2-parity.spec.ts --headed --reporter=line
//
// Output: a parity table (DC% = fraction of differing pixels, maxΔ = worst channel delta)
// per fixture, plus before/after/diff PNGs under test-results/webgl2-parity/.
//
// WebGL2 currently fail-closes point/line/heatmap + the r16float OIT accum, so those
// scenes diverge by construction; raster + opaque polygon fill are the meaningful gates.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

type ReadyWin = { __xgisReady?: boolean }

const FIXTURES = (process.env.XGIS_GL2_FIXTURES ?? 'fixture_raster_local,fixture_square,fixture_triangle')
  .split(',').map((s) => s.trim()).filter(Boolean)

const OUT = 'test-results/webgl2-parity'
const W = 600, H = 600

async function shoot(page: import('@playwright/test').Page, id: string, gl2: boolean): Promise<Buffer> {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.setViewportSize({ width: W, height: H })
  await page.goto(`/demo.html?id=${id}&e2e=1${gl2 ? '&forcegl2=1' : ''}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as ReadyWin).__xgisReady === true, null, { timeout: 35_000 })
  await page.waitForTimeout(3500)
  const png = await page.locator('#map').screenshot()
  if (errs.length) console.log(`  [${id} gl2=${gl2}] ${errs.length} page error(s): ${errs[0]?.slice(0, 100)}`)
  return png
}

test('WebGL2 ↔ WebGPU parity (local, real-GPU)', async ({ page }) => {
  test.setTimeout(60_000 * FIXTURES.length)
  mkdirSync(OUT, { recursive: true })
  const rows: string[] = []
  for (const id of FIXTURES) {
    const webgpu = PNG.sync.read(await shoot(page, id, false))
    const webgl2 = PNG.sync.read(await shoot(page, id, true))
    const diff = new PNG({ width: webgpu.width, height: webgpu.height })
    const ndiff = pixelmatch(webgpu.data, webgl2.data, diff.data, webgpu.width, webgpu.height, { threshold: 0 })
    let maxDelta = 0
    for (let i = 0; i < webgpu.data.length; i += 4) {
      for (let c = 0; c < 3; c++) maxDelta = Math.max(maxDelta, Math.abs(webgpu.data[i + c] - webgl2.data[i + c]))
    }
    writeFileSync(`${OUT}/${id}.webgpu.png`, PNG.sync.write(webgpu))
    writeFileSync(`${OUT}/${id}.webgl2.png`, PNG.sync.write(webgl2))
    writeFileSync(`${OUT}/${id}.diff.png`, PNG.sync.write(diff))
    const pct = (100 * ndiff / (webgpu.width * webgpu.height)).toFixed(2)
    rows.push(`  ${id.padEnd(28)} DC=${pct.padStart(6)}%  maxΔ=${String(maxDelta).padStart(3)}`)
  }
  console.log('\n=== WebGL2 ↔ WebGPU parity (DC=0 / maxΔ=0 is full parity) ===\n' + rows.join('\n') + '\n')
  // This is a measurement harness, not a hard gate — it never fails the run. Read the
  // table + the diff PNGs. (Flip to expect(...) once a backend reaches parity to lock it.)
  expect(FIXTURES.length).toBeGreaterThan(0)
})
