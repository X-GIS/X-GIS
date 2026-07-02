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

  // EVENT-DRIVEN settle — wait for the map's own 'idle' event (the render loop
  // reports nothing left to draw), not a wall-clock sleep. invalidate() first so
  // one more frame is forced and 'idle' RE-fires even if it already passed before
  // the listener attached (the attach race). A never-idle regression fails loud.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const m = (window as unknown as {
      __xgisMap?: { on?: (t: string, cb: () => void) => void; invalidate?: () => void }
    }).__xgisMap
    if (!m?.on) return reject(new Error('__xgisMap.on unavailable — demo did not expose the map'))
    const t = setTimeout(() => reject(new Error("map never fired 'idle' within 30s")), 30_000)
    m.on('idle', () => { clearTimeout(t); resolve() })
    m.invalidate?.()
  }))

  // CANVAS-NATIVE capture: canvas.toBlob reads the map's own backbuffer — map
  // pixels ONLY. The demo overlays (#status label / snapshot button / hash badge)
  // that an element screenshot composites in are unrepresentable here (the
  // reloc-DC0 demo-chrome pollution class). Same readback surface the map's own
  // __xgisSnapshot pixel hash uses. Streaming can re-dirty the frame after an
  // 'idle' (glyph/sprite late arrivals), so capture until two consecutive reads
  // are byte-identical (bounded — no unconditional sleep).
  const grab = async (): Promise<Buffer> => Buffer.from(await page.evaluate(() =>
    new Promise<string>((resolve, reject) => {
      const c = document.getElementById('map') as HTMLCanvasElement | null
      if (!c || typeof c.toBlob !== 'function') return reject(new Error('#map canvas missing'))
      c.toBlob((b) => {
        if (!b) return reject(new Error('canvas.toBlob returned null'))
        const r = new FileReader()
        r.onload = () => resolve((r.result as string).split(',')[1] ?? '')
        r.onerror = () => reject(new Error('blob read failed'))
        r.readAsDataURL(b)
      }, 'image/png')
    })), 'base64')
  let png = await grab()
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(300)
    const next = await grab()
    const settled = Buffer.compare(png, next) === 0
    png = next
    if (settled) break
  }
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
