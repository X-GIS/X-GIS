// ═══ Mips kill the CRAWL, measured as crawl (#1436) ═══
//
// The aliasing this fixes is TEMPORAL. A static sharpness number cannot see it: a
// single-mip frame and a mipped frame are both "a picture of tiles", and the mipped one is by
// construction the BLURRIER of the two — so any gate phrased as "more detail after" would be
// measuring the wrong sign and would pass most brightly on the bug.
//
// What actually goes wrong is that a screen pixel covering many texels averages exactly 4 of
// them, and one sub-degree camera step later averages a DIFFERENT 4. So the honest measurement
// is the one this gate makes: render two frames a hair apart, and ask how much the image
// changed. Under-sampled, the far field boils and the inter-frame delta is large. With a mip
// chain the same step barely moves it.
//
// The camera step is deliberately far below the scale of any real feature — no tile boundary
// crosses, no LOD switches, nothing loads. Everything that changes between the two frames is
// resampling noise, which is precisely the quantity under test.
//
// Runs on WebGL2 under SwiftShader (mips and aniso are WebGL2 features, so this is NOT in the
// WebGPU-only blind spot). Anisotropy may or may not be available on this rasterizer; the spec
// REPORTS which it got via the RHI capability read rather than assuming, so a run that measured
// mips alone says so instead of quietly claiming both.

import { test, expect, type Page } from '@playwright/test'

const W = 420
const H = 700
// Pitched hard: at pitch the far field is most of the frame and is already metres-per-pixel,
// which is the minification regime where a single-level tap is guaranteed wrong.
const CAM = '#4.2/24.0/121.0/0/72'
const STEP = 0.03 // degrees of bearing — far below any feature scale

async function ready(page: Page, camera: string): Promise<void> {
  await page.goto(`/demo.html?id=fixture_raster_local&forcegl2=1&e2e=1&adaptive=0${camera}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 60_000 },
  )
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __xgisMap?: { getMissingTileCount(): number } }
      ).__xgisMap?.getMissingTileCount() === 0,
    { timeout: 60_000 },
  )
  await page.waitForTimeout(1500)
}

/** RGBA bytes of the live canvas, read straight off the GL context. */
async function pixels(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const cv = document.querySelector('canvas') as HTMLCanvasElement
    const gl = cv.getContext('webgl2', { preserveDrawingBuffer: true })!
    const buf = new Uint8Array(cv.width * cv.height * 4)
    gl.readPixels(0, 0, cv.width, cv.height, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    let s = ''
    for (const v of buf) s += String.fromCharCode(v)
    return btoa(s)
  })
  return Buffer.from(b64, 'base64')
}

/** Mean absolute per-channel difference, 0..255. The quantity that IS the crawl. */
function meanAbsDelta(a: Buffer, b: Buffer): number {
  expect(a.length, 'both frames must be the same size').toBe(b.length)
  let sum = 0
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
    n += 3
  }
  return sum / n
}

/** Move the camera by a hair and return how much the image changed. */
async function crawlOf(page: Page, bearing: number): Promise<number> {
  await ready(page, `#4.2/24.0/121.0/${bearing}/72`)
  const first = await pixels(page)
  await ready(page, `#4.2/24.0/121.0/${bearing + STEP}/72`)
  const second = await pixels(page)
  return meanAbsDelta(first, second)
}

test('a sub-degree camera step barely moves a mipped frame (#1436)', async ({ page }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  await page.setViewportSize({ width: W, height: H })
  await ready(page, CAM)

  // NON-VACUITY, first: if the sampler never received the descriptor, everything below would be
  // measuring the same single-mip pipeline twice and would agree beautifully for no reason.
  const caps = await page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: { ctx?: { rhi?: { backend: string; maxAnisotropy: number } } }
      }
    ).__xgisMap
    return {
      backend: m?.ctx?.rhi?.backend ?? 'none',
      maxAnisotropy: m?.ctx?.rhi?.maxAnisotropy ?? 0,
    }
  })
  expect(caps.backend, 'a silent fallback must not green this gate').toBe('webgl2')
  // REPORTED, not asserted: SwiftShader may or may not expose the aniso extension, and the
  // capability read exists precisely so a run can say which half it measured.
  console.log(
    `[mip-crawl] backend=${caps.backend} maxAnisotropy=${caps.maxAnisotropy}` +
      `${caps.maxAnisotropy > 1 ? ' (mips + aniso)' : ' (mips only — no EXT_texture_filter_anisotropic here)'}`,
  )

  const crawl = await crawlOf(page, 0)
  console.log(`[mip-crawl] inter-frame delta at ${STEP}° = ${crawl.toFixed(4)}/255`)

  // The frame must not be blank — a black canvas has a delta of 0 and would sail through the
  // bound below while proving nothing.
  const frame = await pixels(page)
  let nonBlack = 0
  for (let i = 0; i < frame.length; i += 4)
    if (frame[i] > 8 || frame[i + 1] > 8 || frame[i + 2] > 8) nonBlack++
  expect(nonBlack / (frame.length / 4), 'the raster must actually be drawn').toBeGreaterThan(0.2)

  // MEASURED, not guessed — the distribution before the bound was chosen:
  //
  //   without mips/aniso   2.1127
  //   with    mips/aniso   1.3549      (1.56x separation, 36% less crawl)
  //   same-code noise      0.0000      (three runs, bit-identical: SwiftShader is deterministic
  //                                     here, so every point of that gap is signal)
  //
  // The bound is the GEOMETRIC MIDPOINT of the two, which with a zero noise floor puts 24.9%
  // either way — a regression has to give back two thirds of the win to sneak past, and nothing
  // short of that can flake it. An earlier draft of this line said 2.0, which left 5.6% against
  // the before number; that is the shape of bound that made #1420 flake, and it is not defensible
  // just because it happened to pass.
  expect(crawl, `a ${STEP}° step must not boil the far field`).toBeLessThan(1.69)

  expect(errors, 'no page errors').toEqual([])
})
