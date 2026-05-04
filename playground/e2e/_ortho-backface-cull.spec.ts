// Verify line + point shaders cull back-hemisphere fragments under
// orthographic projection. Mirrors the polygon shader's pattern
// (renderer.ts: cos_c varying + fragment discard).
//
// Oracle: at orthographic projection centered such that the visible
// line/point sits on the far hemisphere, the canvas should be empty
// (no stroke/marker visible). Pre-fix: line/point would still render
// because their shaders had no needs_backface_cull dispatch.

import { test, expect, type Page } from '@playwright/test'

async function waitForXgisReady(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
}

async function snapAndCount(page: Page, target: 'amber' | 'cyan' | 'red') {
  const sShot = await page.screenshot({ type: 'png' })
  return await page.evaluate(async ({ pngBytes, target }) => {
    const blob = new Blob([new Uint8Array(pngBytes)], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res(); img.onerror = () => rej(new Error('img'))
      img.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, img.width, img.height).data
    let hits = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2]
      if (target === 'amber' && r > 180 && g > 130 && g < 200 && b < 100) hits++
      if (target === 'cyan' && r < 100 && g > 200 && b > 200) hits++
      if (target === 'red' && r > 200 && g < 100 && b < 100) hits++
    }
    URL.revokeObjectURL(url)
    return hits
  }, { pngBytes: Array.from(sShot), target })
}

test('orthographic: line on FRONT hemisphere is visible', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  // Camera centered near the line so it's clearly on the front hemisphere.
  await page.goto(
    '/demo.html?id=reftest_stroke_static&safe=1&proj=orthographic#3.00/19.37069/-55.74624',
    { waitUntil: 'domcontentloaded' },
  )
  await waitForXgisReady(page)
  await page.waitForTimeout(2500)
  const amber = await snapAndCount(page, 'amber')
  console.log(`[front] amber pixels: ${amber}`)
  expect(amber, 'line should render on front hemisphere').toBeGreaterThan(100)
})

test('orthographic: line on BACK hemisphere is culled', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  // Camera at the antipode (≈ +180° lon away from the line). Original
  // line sat at ~lon=-50..-20 / lat=-20..20 (per fixture-line.geojson).
  // Antipode camera: lon≈+130, lat=0. Ortho should hide the line entirely.
  await page.goto(
    '/demo.html?id=reftest_stroke_static&safe=1&proj=orthographic#3.00/0/130',
    { waitUntil: 'domcontentloaded' },
  )
  await waitForXgisReady(page)
  await page.waitForTimeout(2500)
  const amber = await snapAndCount(page, 'amber')
  console.log(`[back] amber pixels: ${amber}`)
  expect(amber, 'line on back hemisphere must be culled').toBeLessThan(100)
})

test('orthographic: triangle stroke on BACK hemisphere is culled', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  // Triangle vertices in fixture-triangle.geojson: (-30,-20), (30,-20),
  // (0, 30) — all near equator. Antipode camera at (lon=180, lat=0)
  // puts the triangle on the far hemisphere.
  await page.goto(
    '/demo.html?id=fixture_stroke_fill&safe=1&proj=orthographic#3.00/0/180',
    { waitUntil: 'domcontentloaded' },
  )
  await waitForXgisReady(page)
  await page.waitForTimeout(2500)
  const amber = await snapAndCount(page, 'amber')
  console.log(`[back-tri] amber pixels: ${amber}`)
  expect(amber, 'triangle stroke on back hemisphere must be culled').toBeLessThan(100)
})
