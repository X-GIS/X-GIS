// Smoke test for the landing-page hero map (GeoJSON path through
// MapRenderer, NOT VTR). Regression caught: after the per-tile
// clip mask added `clip_bounds: vec4<f32>` to WGSL Uniforms (commit
// 9c026b3), MapRenderer still wrote a 160-byte uniform block — the
// extra 16 bytes for clip_bounds were left unwritten. Shader read
// garbage at byte 160; if the garbage happened to satisfy
// `clip_bounds.x > -1e29` the per-fragment discard fired and most
// of the world disappeared.
//
// User-visible symptom: landing page hero map showing only ~1/4 of
// the world (Africa + Australia) at the bottom-right of the canvas.

import { test, expect } from '@playwright/test'

test('landing-page hero map renders the full world', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  // The site dev server lives separately from the playground dev
  // server (different port). Use the built static output via file://
  // is brittle; instead run against the production-style site build
  // path served by the playground server's /static or hit the deployed
  // demo. For now: navigate to the playground's `id=minimal` demo
  // which uses the SAME GeoJSON-on-MapRenderer path as the hero map.
  await page.goto('/demo.html?id=minimal#0/0/0/0/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(3_000) // settle

  // Capture the canvas pixels and check: how much of the canvas is
  // NON-BACKGROUND? At zoom 0 the world should fill most of the
  // viewport. If clip_bounds garbage is discarding fragments, the
  // non-background coverage drops dramatically.
  const stats = await page.evaluate(async () => {
    const canvas = document.getElementById('map') as HTMLCanvasElement
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), 'image/png'),
    )
    if (!blob) return { error: 'no blob' }
    const buf = await blob.arrayBuffer()
    const img = new Image()
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }))
    await new Promise<void>((res, rej) => {
      img.onload = () => res(); img.onerror = () => rej(new Error('decode'))
      img.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, img.width, img.height).data
    let nonBg = 0
    let total = 0
    for (let i = 0; i < data.length; i += 4) {
      total++
      // Background is darker (near black). Land is lighter
      // (zinc-200 is roughly RGB ~228). Threshold: any pixel
      // with luminance > 50 counts as "rendered land".
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3
      if (lum > 50) nonBg++
    }
    return { nonBgFraction: nonBg / total, width: img.width, height: img.height }
  })
  // eslint-disable-next-line no-console
  console.log(`[hero-map] canvas ${(stats as { width: number; height: number }).width}×${(stats as { width: number; height: number }).height}, non-bg fraction = ${((stats as { nonBgFraction: number }).nonBgFraction * 100).toFixed(1)}%`)
  await page.locator('#map').screenshot({ path: 'test-results/hero-map-render.png' })

  if ('error' in stats) throw new Error(stats.error as string)
  // World at zoom 0 covers most of the canvas; expect ≥ 15% non-bg
  // (lots of ocean = bg, but land + continents should fill enough).
  // The bug produced ~3% non-bg (only Africa + Australia visible).
  expect(stats.nonBgFraction,
    `hero map shows only ${(stats.nonBgFraction * 100).toFixed(1)}% non-background — clip_bounds discard regression?`,
  ).toBeGreaterThan(0.10)
})
