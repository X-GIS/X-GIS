// ═══ Demo.actions interaction-infra gate (#1192) ═══
//
// The gallery's action buttons must drive the LIVE map through public APIs:
//  • color_switcher — "Change a layer's color with buttons" port: clicking
//    "Rose fill" recolours the mounted countries fill via setPaintProperty.
//  • fly_to — "Fly to a location" port: clicking "Seoul" moves the camera
//    via map.flyTo (hash + frame change).
//  • camera_around_point — "Animate map camera around a point" port: Start
//    advances map.setBearing() from a host rAF loop; Stop halts it.
//  • animate_point_route — "Animate a point along a route" port: Start
//    slides the marker via per-frame map.updateFeature().
// Demos WITHOUT actions must not show the bar.

import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

const DIR = '/tmp/claude-0/-home-user-X-GIS/8da4ef15-9f91-58b5-8776-d8104f8ea4eb/scratchpad'

async function boot(page: Page, id: string): Promise<void> {
  await page.goto(`/demo.html?id=${id}&e2e=1&forcegl2=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 60_000 },
  )
  await pump(page)
}

async function pump(page: Page): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() =>
      (window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.(),
    )
    await page.waitForTimeout(80)
  }
}

const shoot = async (page: Page, path: string): Promise<PNG> => {
  const buf = await page.locator('#xg-canv, canvas').first().screenshot({ path })
  return PNG.sync.read(buf)
}

function diff(a: PNG, b: PNG): number {
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2]
    )
      n++
  }
  return n
}

/** Dominant land colour: the most frequent non-background pixel. */
function dominant(png: PNG): [number, number, number] {
  const counts = new Map<number, number>()
  const bg = (png.data[0]! << 16) | (png.data[1]! << 8) | png.data[2]!
  for (let i = 0; i < png.data.length; i += 4) {
    const key = (png.data[i]! << 16) | (png.data[i + 1]! << 8) | png.data[i + 2]!
    if (key === bg) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best = 0
  let bestKey = 0
  for (const [k, c] of counts) {
    if (c > best) {
      best = c
      bestKey = k
    }
  }
  return [(bestKey >> 16) & 255, (bestKey >> 8) & 255, bestKey & 255]
}

test('color_switcher: "Rose fill" recolours the live layer', async ({ page }) => {
  test.setTimeout(240_000)
  await boot(page, 'color_switcher')
  await expect(page.locator('#demo-actions')).toBeVisible()
  const before = await shoot(page, `${DIR}/actions-color-before.png`)
  const [, , bBlue] = dominant(before)

  await page.getByRole('button', { name: 'Rose fill' }).click()
  await pump(page)
  const after = await shoot(page, `${DIR}/actions-color-after.png`)
  const [aRed, , aBlue] = dominant(after)

  const d = diff(before, after)
  console.log(
    `[demo-actions] color diff=${d}/${before.width * before.height} dominant before(b=${bBlue}) after(r=${aRed},b=${aBlue})`,
  )
  // Sky (#0ea5e9, blue-dominant) → rose (#f43f5e, red-dominant): the land
  // mass recolours (≫ noise floor) and the dominant channel flips.
  expect(d).toBeGreaterThan(50_000)
  expect(aRed).toBeGreaterThan(aBlue)
  expect(bBlue).toBeGreaterThan(150)
})

test('fly_to: "Seoul" moves the camera; actionless demos hide the bar', async ({ page }) => {
  test.setTimeout(240_000)
  await boot(page, 'fly_to')
  await expect(page.locator('#demo-actions')).toBeVisible()
  const before = await shoot(page, `${DIR}/actions-fly-before.png`)

  await page.getByRole('button', { name: 'Seoul' }).click()
  await pump(page)
  const after = await shoot(page, `${DIR}/actions-fly-after.png`)

  const d = diff(before, after)
  console.log(`[demo-actions] fly diff=${d}/${before.width * before.height} hash=${page.url()}`)
  expect(d).toBeGreaterThan(100_000) // world view → z8 Seoul: most of the frame changes
  const hash = await page.evaluate(() => location.hash)
  expect(hash).toContain('8.00') // zoom 8 reached the camera hash sync

  await boot(page, 'minimal')
  await expect(page.locator('#demo-actions')).toBeHidden()
})

const getBearing = (page: Page): Promise<number> =>
  page.evaluate(() =>
    (window as unknown as { __xgisMap: { getBearing(): number } }).__xgisMap.getBearing(),
  )

test('camera_around_point: Start spins the bearing, Stop halts it', async ({ page }) => {
  test.setTimeout(240_000)
  await boot(page, 'camera_around_point')
  await expect(page.locator('#demo-actions')).toBeVisible()
  const before = await getBearing(page)
  const frameBefore = await shoot(page, `${DIR}/actions-rotate-before.png`)

  await page.getByRole('button', { name: 'Start rotation' }).click()
  await page.waitForTimeout(700)
  const during = await getBearing(page)
  // ~12°/s: 700ms of rotation moves the bearing well past noise.
  const spun = (during - before + 360) % 360
  expect(spun).toBeGreaterThan(2)

  await page.getByRole('button', { name: 'Stop rotation' }).click()
  const atStop = await getBearing(page)
  await page.waitForTimeout(500)
  const afterStop = await getBearing(page)
  expect(Math.abs(afterStop - atStop)).toBeLessThan(0.01)

  await pump(page)
  const frameAfter = await shoot(page, `${DIR}/actions-rotate-after.png`)
  const d = diff(frameBefore, frameAfter)
  console.log(`[demo-actions] rotate bearing ${before}→${afterStop} framediff=${d}`)
  expect(d).toBeGreaterThan(10_000) // the tilted world visibly rotated
})

/** Centroid of rose-500-ish pixels (the route marker) — structural
 *  position assert, immune to overlay-DOM noise that a raw pixel-count
 *  diff would happily accept as "movement". */
function roseCentroid(png: PNG): [number, number] | null {
  let sx = 0
  let sy = 0
  let n = 0
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4
      const [r, g, b] = [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!]
      if (r > 200 && g < 110 && b < 130) {
        sx += x
        sy += y
        n++
      }
    }
  }
  return n > 20 ? [sx / n, sy / n] : null
}

test('animate_point_route: Start moves the marker along the route', async ({ page }) => {
  test.setTimeout(240_000)
  await boot(page, 'animate_point_route')
  await expect(page.locator('#demo-actions')).toBeVisible()
  const before = await shoot(page, `${DIR}/actions-route-before.png`)
  const c0 = roseCentroid(before)

  await page.getByRole('button', { name: 'Start', exact: true }).click()
  // 10s loop: 1.5s ≈ 15% of the SF→DC arc — several hundred px of travel.
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await pump(page)
  const after = await shoot(page, `${DIR}/actions-route-after.png`)
  const c1 = roseCentroid(after)

  // The tick loop must not have crashed (a dead rAF leaves the marker at
  // SF while overlay noise still passes a naive pixel-count diff).
  const errText = await page.locator('#error-msg').textContent()
  expect(errText ?? '').not.toMatch(/TypeError|undefined/)

  console.log(`[demo-actions] route marker centroid ${c0} → ${c1}`)
  expect(c0).not.toBeNull()
  expect(c1).not.toBeNull()
  // SF→DC runs west→east: the centroid must travel right by far more
  // than antialias jitter.
  expect(c1![0] - c0![0]).toBeGreaterThan(30)
})
