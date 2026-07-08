// LOCAL-ONLY regression gate (#834 M5 final) — OFM Bright renders the SAME on
// the WebGL2 backend (?forcegl2=1) as on WebGPU. Locks the three root-cause gl2
// bugs the M5-final pixel gate found, so they can't silently come back:
//   1. point-label dedup maps never cleared on the forced frame → place/POI
//      labels vanished from frame 2  (asserted via the dark-pixel / label ratio)
//   2. flat-fill Material used the depth-TESTING variant, so per-feature jitter
//      (not style order) decided fill overlap → landcover erased by landuse
//      (asserted via the park-green interior sample point)
//   3. the GLSL compositor sampled the MAX-blend offscreen RT without the GL
//      v-flip → translucent stroke tint composited on the wrong half
//      (asserted via the building/water interior sample points)
//
// LOCAL-ONLY: the OFM Bright tiles/glyphs/sprite are served from
// playground/public/ofm-mirror/ (gitignored, regenerate per the #834 notes) —
// absent in CI and on a fresh checkout, so the test SKIPS when the mirror is
// missing rather than failing. Capture is canvas.toBlob (pixels only, no DOM
// overlay). Thresholds carry SwiftShader run-to-run headroom above the healthy
// baseline (tolerant diff 3.7%, sample points Δ0, label ratio 0.999).

import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const OUT = 'test-results/bright-gl2'
const MIRROR = 'public/ofm-mirror/bright-local.json'

// Interior fill sample points (Tokyo z14, 900×700 → canvas 480×700 after DPR):
// park-green / building / water / road pixels that were byte-identical gl2↔gpu
// once the three bugs were fixed. Interior (not edges) so the documented
// single-sample-vs-4×MSAA outline speckle doesn't false-positive.
const SAMPLES: ReadonlyArray<readonly [number, number]> = [
  [60, 60], // highway fill
  [170, 480], // landcover-grass (bug 2 lock)
  [300, 180], // building (bug 3 lock)
  [120, 300], // water
  [400, 250],
  [330, 560], // building
  [80, 600], // building
  [430, 80], // highway major
]
const SAMPLE_TOL = 24 // per-channel; healthy is 0, headroom for SwiftShader jitter
// Coarse sanity bound only. The whole-frame tolerant diff is dominated by
// single-sample-vs-4×MSAA edge speckle whose SwiftShader run-to-run variance is
// wide (observed 3.7–7.9% healthy) — it is a tripwire for GROSS corruption, not
// the verdict on the three bugs (§5: a scalar ratio never decides alone). The
// targeted sample-point + label-ratio checks below are the real, stable gate.
const TOLERANT_DIFF_MAX = 12.0 // % — gross-corruption catch-all, well above the noisy baseline
const LABEL_RATIO_MIN = 0.85 // gl2/gpu dark-pixel count (healthy 0.999; bug 1 craters it)

async function shoot(page: import('@playwright/test').Page, gl2: boolean): Promise<Buffer> {
  await page.setViewportSize({ width: 900, height: 700 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text()))
      errors.push(m.text().slice(0, 200))
  })
  await page.goto(
    `/demo.html?id=ofm_bright_local&e2e=1${gl2 ? '&forcegl2=1' : ''}#14/35.68/139.76/0/0`,
    { waitUntil: 'domcontentloaded' },
  )
  try {
    await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 60_000 })
  } catch (e) {
    console.log(`NOT-READY(${gl2 ? 'gl2' : 'gpu'})`, JSON.stringify(errors.slice(0, 10)))
    throw e
  }
  // Long settle: style fetch + tile fetch + glyph/sprite + SwiftShader compile.
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(6000)
    await page.evaluate(() => (window as any).__xgisMap?.invalidate?.())
  }
  await page.waitForTimeout(2000)
  // Canvas pixels ONLY via toBlob — an element screenshot composites any DOM
  // painted over the canvas (the demo log overlay captures the forcegl2 boot
  // console.warn and poisons the bottom-right tiles). Invalidate + two rAFs
  // first so the presented frame is fresh at read time.
  const b64 = await page.evaluate(async () => {
    ;(window as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
    const canvas = document.querySelector('canvas')!
    const blob = await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob returned null'))), 'image/png'),
    )
    const u8 = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000)
      s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
    return btoa(s)
  })
  return Buffer.from(b64, 'base64')
}

/** Luma at (x,y). */
function luma(d: PNG, x: number, y: number): number {
  const i = (y * d.width + x) * 4
  return 0.299 * d.data[i]! + 0.587 * d.data[i + 1]! + 0.114 * d.data[i + 2]!
}

/** 1-px-tolerant content diff %: a pixel counts only when NO pixel in the other
 *  image's 3×3 neighbourhood matches within TH luma (both directions). Absorbs
 *  sub-pixel AA / MSAA speckle; catches real content divergence. */
function tolerantDiffPct(a: PNG, b: PNG): number {
  const W = a.width,
    H = a.height,
    TH = 12
  const la = new Float32Array(W * H),
    lb = new Float32Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      la[y * W + x] = luma(a, x, y)
      lb[y * W + x] = luma(b, x, y)
    }
  const near = (s: Float32Array, d: Float32Array, x: number, y: number): boolean => {
    const v = s[y * W + x]!
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx,
          ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        if (Math.abs(v - d[ny * W + nx]!) <= TH) return true
      }
    return false
  }
  let diff = 0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (!near(la, lb, x, y) || !near(lb, la, x, y)) diff++
  return (100 * diff) / (W * H)
}

/** Dark-pixel count (luma < 90) — labels + road casings; a proxy for "text is
 *  present". Bug 1 (labels suppressed on gl2) craters the gl2 count vs gpu. */
function darkCount(d: PNG): number {
  let n = 0
  const px = d.width * d.height
  for (let i = 0; i < px; i++) {
    const o = i * 4
    if (0.299 * d.data[o]! + 0.587 * d.data[o + 1]! + 0.114 * d.data[o + 2]! < 90) n++
  }
  return n
}

test('OFM Bright: WebGL2 renders the same as WebGPU (local gate)', async ({ page, context }) => {
  test.skip(!existsSync(MIRROR), `OFM Bright mirror absent (${MIRROR}) — local-only gate, regenerate per #834`)
  test.setTimeout(540_000)
  mkdirSync(OUT, { recursive: true })

  const gl2Png = await shoot(page, true)
  const p2 = await context.newPage()
  const gpuPng = await shoot(p2, false)
  writeFileSync(`${OUT}/webgl2.png`, gl2Png)
  writeFileSync(`${OUT}/webgpu.png`, gpuPng)

  const gl2 = PNG.sync.read(gl2Png)
  const gpu = PNG.sync.read(gpuPng)
  expect(gl2.width, 'capture dimensions must match').toBe(gpu.width)
  expect(gl2.height).toBe(gpu.height)

  // (1) Interior fill sample points — the STABLE gate. Locks bug 2 (ground-fill
  //     overlap: park green) + bug 3 (composite v-flip: building/water tint).
  //     Each must agree within a small per-channel tolerance (healthy Δ0).
  for (const [x, y] of SAMPLES) {
    const i = (y * gpu.width + x) * 4
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(gpu.data[i + c]! - gl2.data[i + c]!)
      expect(d, `sample (${x},${y}) ch${c}: gl2 fill diverged from gpu`).toBeLessThanOrEqual(
        SAMPLE_TOL,
      )
    }
  }

  // (2) Label presence — locks bug 1 (point-label dedup never cleared → labels
  //     vanished). Stable: dark-pixel counts are whole-frame integrals.
  const ratio = darkCount(gl2) / darkCount(gpu)
  console.log(`BRIGHT-GATE label-ratio=${ratio.toFixed(3)}`)
  expect(
    ratio,
    'gl2 dark-pixel (label) count vs gpu — a crater means labels vanished',
  ).toBeGreaterThan(LABEL_RATIO_MIN)

  // (3) Coarse whole-frame sanity — catches gross corruption only (see the
  //     TOLERANT_DIFF_MAX note); logged for trend visibility.
  const diffPct = tolerantDiffPct(gpu, gl2)
  console.log(`BRIGHT-GATE tolerant-diff=${diffPct.toFixed(3)}%`)
  expect(diffPct, 'gl2↔gpu whole-frame tolerant diff (gross-corruption catch-all)').toBeLessThan(
    TOLERANT_DIFF_MAX,
  )
})
