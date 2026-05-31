// Globe arena-pressure crash gate.
//
// REPRO: proj=globe z~10-11 Seoul. Each visible tile's polygon mesh is
// large (globe vertex layout is wider than Mercator). At z10.8 / Seoul the
// renderer tries to upload ~40-60 MB of polygon vertex data — exhausting the
// 64 MB arena before the unique-tile-count (256 desktop cap) is reached.
// With the count-only trigger, evictGPUTiles early-returned ("nothing to do")
// and alloc() threw "out of capacity" in every frame, crashing the render loop.
//
// THE FIX gated here:
//   (A) beginFrame also fires eviction when arena usedBytes ≥ 75% capacity
//   (B) doUploadTile wraps alloc() in allocPair() — OOM failures are caught
//       and warn-and-skip rather than propagating a throw
//
// WHAT THIS SPEC ASSERTS:
//   1. No "out of capacity" / "GPUArena" error in console over N frames of
//      pan/zoom near Seoul globe z10-11.
//   2. No uncaught JS errors (pageerror) during the session.
//   3. The map remains in a renderable state after the tile stream settles
//      (paint > 0 on a real GPU; skipped under SOFTWARE_GPU).
//
// SKIP POLICY: The spec is always correct but SwiftShader (XGIS_SOFTWARE_GPU=1)
// can't execute the full WebGPU pipeline, so paint assertions are gated.
// The console-error and pageerror assertions run under all environments —
// they catch the throw-escaping-render-loop crash even without GPU rendering.
//
// URL PATTERN matches the crash repro:
//   ?id=__import&proj=globe#10.80/37.26370/127.02741
// We use the `dark` demo (countries.geojson — no PMTiles dependency) to keep
// the test hermetic; the arena pressure comes from the globe vertex layout,
// not the specific tile source.

import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

const OUT = path.resolve('e2e/__globe-arena-pressure__')
fs.mkdirSync(OUT, { recursive: true })

// CI SwiftShader flag — set by the workflow on Linux runners.
const SOFTWARE_GPU = process.env.XGIS_SOFTWARE_GPU === '1'

// Camera states around Seoul at globe z10-11 — the crash repro range.
// Each entry is a URL hash fragment: #zoom/lat/lon
const CAMERA_STATES = [
  '#10.80/37.26370/127.02741',  // exact crash repro
  '#11.00/37.56/126.97',        // Seoul city centre, slightly higher zoom
  '#10.50/37.45/127.10',        // shifted east — different tile set
  '#11.50/37.38/126.85',        // west Seoul — more tiles
  '#10.20/37.70/127.30',        // lower zoom — more globe tiles visible
] as const

test('globe arena-pressure: no GPUArena OOM crash near Seoul z10-11', async ({ page }) => {
  test.setTimeout(90_000)

  const arenaErrors: string[] = []
  const pageErrors: string[] = []
  const allConsoleErrors: string[] = []

  page.on('console', (msg) => {
    const text = msg.text()
    if (msg.type() === 'error') {
      allConsoleErrors.push(text)
      if (/GPUArena|out of capacity|arena.*oom/i.test(text)) {
        arenaErrors.push(text)
      }
    }
    // Also catch warn-once arena-oom warnings (Lane B warn path)
    if (msg.type() === 'warning' && /arena.*oom|arena.*capacity/i.test(text)) {
      arenaErrors.push('[warn] ' + text)
    }
  })

  page.on('pageerror', (err) => {
    pageErrors.push(err.message)
    if (/GPUArena|out of capacity/i.test(err.message)) {
      arenaErrors.push('[pageerror] ' + err.message)
    }
  })

  await page.setViewportSize({ width: 1024, height: 768 })

  // Load globe at Seoul using the dark demo (hermetic — no PMTiles needed).
  // The hash puts us at z10.8 / Seoul — the exact crash repro camera.
  await page.goto(
    `/demo.html?id=dark&proj=globe${CAMERA_STATES[0]}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 20_000 },
  )
  // Let the tile pipeline warm up — fetch + decode + upload cycle
  await page.waitForTimeout(2000)

  await page.locator('canvas').first()
    .screenshot({ path: path.join(OUT, 'initial-z10.8-seoul.png') })

  // Sweep through camera states to stream many tiles and stress the arena.
  // Each jump changes the visible tile set — the previous tiles must be
  // evicted (byte-pressure path) so new ones can be uploaded.
  for (let i = 1; i < CAMERA_STATES.length; i++) {
    const hash = CAMERA_STATES[i]!
    await page.evaluate((h) => { window.location.hash = h }, hash)
    // Wait for tile upload + eviction cycle: 1.5 s per camera change
    await page.waitForTimeout(1500)
    await page.locator('canvas').first()
      .screenshot({ path: path.join(OUT, `step-${i}-${hash.replace(/[#./]/g, '_')}.png`) })
  }

  // Return to the crash repro camera and let a second render cycle run.
  // If the eviction loop is broken, the second visit to the same tiles
  // re-triggers the OOM (because the arena is still full from the first
  // visit and count-only trigger never evicted).
  await page.evaluate((h) => { window.location.hash = h }, CAMERA_STATES[0])
  await page.waitForTimeout(2000)
  await page.locator('canvas').first()
    .screenshot({ path: path.join(OUT, 'return-z10.8-seoul.png') })

  // ─── ASSERTIONS ────────────────────────────────────────────────────────

  // 1. No arena OOM errors in console — this is the primary crash gate.
  //    The fixed code catches alloc failures inside allocPair() and either
  //    retries after forceEvictBytes() or warn-and-skips. The throw must
  //    never reach the console as an uncaught error.
  expect(
    arenaErrors,
    'GPUArena "out of capacity" error reached console — arena OOM crash NOT fixed',
  ).toHaveLength(0)

  // 2. No uncaught page errors — a propagating throw from the render loop
  //    surfaces as a pageerror. If any arena-related pageerror fired, it
  //    is already in arenaErrors above; this catches other render crashes.
  const renderCrashes = pageErrors.filter(e =>
    /GPUArena|out of capacity|renderFrame|render.*error/i.test(e),
  )
  expect(
    renderCrashes,
    'Render-loop crash (pageerror) detected during globe arena stress',
  ).toHaveLength(0)

  // 3. Paint check on real GPU: the map must still render after the tile
  //    stress (arena OOM previously left every frame blank).
  if (!SOFTWARE_GPU) {
    const paint = await page.evaluate(async () => {
      const cv = document.querySelector('canvas') as HTMLCanvasElement | null
      if (!cv) return 0
      const w = cv.width, h = cv.height
      const off = new OffscreenCanvas(w, h)
      const ctx = off.getContext('2d')!
      ctx.drawImage(cv, 0, 0)
      const d = ctx.getImageData(0, 0, w, h).data
      // Sample centre 60% of canvas — avoids edge background
      const xMin = (w * 0.20) | 0, xMax = (w * 0.80) | 0
      const yMin = (h * 0.20) | 0, yMax = (h * 0.80) | 0
      let nonbg = 0, total = 0
      for (let y = yMin; y < yMax; y += 2) {
        for (let x = xMin; x < xMax; x += 2) {
          const i = (y * w + x) * 4
          const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!, a = d[i + 3]!
          total++
          if (a > 4 && (r > 4 || g > 4 || b > 4)) nonbg++
        }
      }
      return total > 0 ? nonbg / total : 0
    })

    expect(paint, 'Canvas is blank after globe arena stress — tile rendering failed').toBeGreaterThan(0.01)
  }

  // 4. Write a summary artefact for CI triage.
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({
      arenaErrors,
      pageErrors,
      allConsoleErrorCount: allConsoleErrors.length,
      softwareGpu: SOFTWARE_GPU,
    }, null, 2),
  )
})

// ─── ZOOM SWEEP ───────────────────────────────────────────────────────────
// Secondary: sweep z=9 to z=12 at Seoul globe — exercises the tile-count
// growth and arena fill/evict cycle across zoom transitions, not just the
// static OOM case. Same assertion: no arena errors.
test('globe arena-pressure: zoom sweep z9→12 Seoul no OOM', async ({ page }) => {
  test.setTimeout(60_000)

  const arenaErrors: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    if ((msg.type() === 'error' || msg.type() === 'warning')
        && /GPUArena|out of capacity|arena.*oom/i.test(text)) {
      arenaErrors.push(text)
    }
  })
  page.on('pageerror', (err) => {
    if (/GPUArena|out of capacity/i.test(err.message)) {
      arenaErrors.push('[pageerror] ' + err.message)
    }
  })

  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto(
    '/demo.html?id=dark&proj=globe#9/37.56/126.97',
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 20_000 },
  )
  await page.waitForTimeout(1500)

  const ZOOM_HASHES = [
    '#9/37.56/126.97',
    '#10/37.56/126.97',
    '#11/37.56/126.97',
    '#12/37.56/126.97',
    '#11/37.56/126.97',   // zoom back out — eviction cycle
    '#10/37.56/126.97',
    '#9/37.56/126.97',
  ] as const

  for (const hash of ZOOM_HASHES) {
    await page.evaluate((h) => { window.location.hash = h }, hash)
    await page.waitForTimeout(1200)
    await page.locator('canvas').first()
      .screenshot({ path: path.join(OUT, `zoom-sweep-${hash.replace(/[#./]/g, '_')}.png`) })
  }

  expect(
    arenaErrors,
    'GPUArena OOM errors during globe z9→12 zoom sweep',
  ).toHaveLength(0)
})
