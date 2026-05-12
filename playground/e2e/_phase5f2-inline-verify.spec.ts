// Phase 5f-2 scaffold: verifies the inline-GeoJSON opt-in path
// loads without errors on a demo whose sources are all URL-loaded
// (so the legacy path stays in play) AND that the same demo still
// works when `?virt_inline=1` is set — proving the path-split
// doesn't perturb the URL-loaded sources.
//
// A future spec will exercise an actual inline source
// (host-pushed via `setSourceData`) through the new path once
// shader-variant + filter parity work lands.

import { test, expect } from '@playwright/test'

test('phase5f-2 — virt_inline opt-in is dormant for URL sources', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 800, height: 600 })

  // No-flag baseline.
  await page.goto('/demo.html?id=styled_world#3/30/120', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(3_000)
  const baselineLit = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(b => res(b)))
    if (!blob) return 0
    const buf = await blob.arrayBuffer()
    const img = new Image()
    img.src = URL.createObjectURL(new Blob([buf], { type: 'image/png' }))
    await new Promise<void>((res) => { img.onload = () => res() })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, img.width, img.height).data
    let lit = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2]
      if (r > 30 || g > 30 || b > 30) lit++
    }
    return lit / (data.length / 4)
  })

  // With ?virt_inline=1 (should be no-op for URL sources).
  await page.goto('/demo.html?id=styled_world&virt_inline=1#3/30/120', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(3_000)
  const flagLit = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(b => res(b)))
    if (!blob) return 0
    const buf = await blob.arrayBuffer()
    const img = new Image()
    img.src = URL.createObjectURL(new Blob([buf], { type: 'image/png' }))
    await new Promise<void>((res) => { img.onload = () => res() })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, img.width, img.height).data
    let lit = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2]
      if (r > 30 || g > 30 || b > 30) lit++
    }
    return lit / (data.length / 4)
  })

  // eslint-disable-next-line no-console
  console.log('[phase5f-2 baseline]', baselineLit, '[flag]', flagLit)

  // The two runs should produce within 1 % of each other — the flag
  // is dormant for URL-loaded sources (styled_world is all URLs).
  expect(Math.abs(flagLit - baselineLit)).toBeLessThan(0.01)
})
