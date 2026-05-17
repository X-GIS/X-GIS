// Verify the azimuthal-tilted → globe(projType=7) promotion path keeps
// the far hemisphere occluded across pitch.
//
// Background: PR #146 (787bb41) replaced a true-parallel ortho matrix
// with a TELEPHOTO perspective so clip.w stays varying and the shared
// log-depth buffer can occlude the far hemisphere. Before the fix, the
// "뒷면" of the globe rendered through the front when pitched.
//
// Coverage gap this spec fills: _ortho-backface-cull.spec.ts only tests
// the flat 2D ortho disc (pitch=0) shader-level discard. This spec
// drives pitch={30,45,60} on the SAME antipode camera and asserts the
// antipode amber line stays invisible — i.e. depth/cull defenses both
// hold under the new orbit camera.

import { test, expect, type Page } from '@playwright/test'

async function waitForXgisReady(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
}

async function countAmber(page: Page): Promise<number> {
  const shot = await page.screenshot({ type: 'png' })
  return await page.evaluate(async ({ pngBytes }) => {
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
      if (r > 180 && g > 130 && g < 200 && b < 100) hits++
    }
    URL.revokeObjectURL(url)
    return hits
  }, { pngBytes: Array.from(shot) })
}

// fixture-line.geojson sits at ~lon=-50..-20 / lat=-20..20.
// Antipode camera: lon=130, lat=0 → the line is on the far hemisphere.
// hash = #zoom/lat/lon/bearing/pitch
const ANTIPODE = (pitch: number) => `#3.00/0/130/0/${pitch}`
const FRONT = (pitch: number) => `#3.00/19.37069/-55.74624/0/${pitch}`

const PITCHES = [30, 45, 60]

for (const pitch of PITCHES) {
  test(`ortho pitch=${pitch}: antipode line stays culled`, async ({ page }) => {
    test.setTimeout(45_000)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(
      `/demo.html?id=reftest_stroke_static&safe=1&proj=orthographic${ANTIPODE(pitch)}`,
      { waitUntil: 'domcontentloaded' },
    )
    await waitForXgisReady(page)
    await page.waitForTimeout(2500)
    const amber = await countAmber(page)
    console.log(`[antipode pitch=${pitch}] amber pixels: ${amber}`)
    // Same threshold the pitch=0 sibling uses.
    expect(amber, `pitch=${pitch}: antipode line must not bleed through`).toBeLessThan(100)
  })

  test(`ortho pitch=${pitch}: front line remains visible`, async ({ page }) => {
    test.setTimeout(45_000)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(
      `/demo.html?id=reftest_stroke_static&safe=1&proj=orthographic${FRONT(pitch)}`,
      { waitUntil: 'domcontentloaded' },
    )
    await waitForXgisReady(page)
    await page.waitForTimeout(2500)
    const amber = await countAmber(page)
    console.log(`[front pitch=${pitch}] amber pixels: ${amber}`)
    // Tilt shrinks on-screen line length; relax floor vs. the pitch=0
    // 100-px sibling so AA jitter at high pitch isn't a false negative.
    expect(amber, `pitch=${pitch}: front line must still render`).toBeGreaterThan(30)
  })
}

// Polygon stroke variant — fixture-triangle.geojson vertices straddle
// the equator near lon 0; antipode camera at lon=180. Mirrors the
// pitch=0 sibling in _ortho-backface-cull.spec.ts, extended across the
// pitched (globe-promoted) path.
for (const pitch of PITCHES) {
  test(`ortho pitch=${pitch}: antipode triangle stroke stays culled`, async ({ page }) => {
    test.setTimeout(45_000)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(
      `/demo.html?id=fixture_stroke_fill&safe=1&proj=orthographic#3.00/0/180/0/${pitch}`,
      { waitUntil: 'domcontentloaded' },
    )
    await waitForXgisReady(page)
    await page.waitForTimeout(2500)
    const amber = await countAmber(page)
    console.log(`[antipode-tri pitch=${pitch}] amber pixels: ${amber}`)
    expect(amber).toBeLessThan(100)
  })
}

// One zero-pitch case included so a regression that breaks the pitch=0
// path (the byte-identical 2D disc) shows up in THIS file too, not only
// in _ortho-backface-cull.spec.ts.
test('ortho pitch=0: antipode line culled (sanity)', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(
    `/demo.html?id=reftest_stroke_static&safe=1&proj=orthographic${ANTIPODE(0)}`,
    { waitUntil: 'domcontentloaded' },
  )
  await waitForXgisReady(page)
  await page.waitForTimeout(2500)
  const amber = await countAmber(page)
  console.log(`[antipode pitch=0] amber pixels: ${amber}`)
  expect(amber).toBeLessThan(100)
})
