// ═══ Demo.actions interaction-infra gate (#1192) ═══
//
// The gallery's action buttons must drive the LIVE map through public APIs:
//  • color_switcher — "Change a layer's color with buttons" port: clicking
//    "Rose fill" recolours the mounted countries fill via setPaintProperty.
//  • fly_to — "Fly to a location" port: clicking "Seoul" moves the camera
//    via map.flyTo (hash + frame change).
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
