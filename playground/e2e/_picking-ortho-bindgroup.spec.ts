// Repro for 2026-05-04 user report at
//   demo.html?id=fixture_picking&proj=orthographic#2.40/10.48544/-170.54395
// Validation flood: "Bind group layout of pipeline layout does not
// match layout of bind group set at group index 0" on
// DrawIndexed(3072, ...).

import { test, expect, type Page } from '@playwright/test'

async function waitForXgisReady(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
}

async function loadAndCount(page: Page, url: string): Promise<number> {
  const errs: string[] = []
  page.on('console', m => {
    if (m.type() === 'error' && m.text().includes('frame-validation')) errs.push(m.text())
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await waitForXgisReady(page)
  await page.waitForTimeout(2500)
  return errs.length
}

test('fixture_picking default (mercator): baseline error count', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const n = await loadAndCount(page, '/demo.html?id=fixture_picking#2.40/10.48544/-170.54395')
  console.log(`[mercator] errors=${n}`)
  expect(n, 'baseline mercator should be 0').toBe(0)
})

test('fixture_picking + orthographic: should match mercator (0 errors)', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const n = await loadAndCount(page, '/demo.html?id=fixture_picking&proj=orthographic#2.40/10.48544/-170.54395')
  console.log(`[ortho] errors=${n}`)
  expect(n).toBe(0)
})

test('fixture_categorical (same source) + orthographic: control', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const n = await loadAndCount(page, '/demo.html?id=fixture_categorical&proj=orthographic#2.40/10.48544/-170.54395')
  console.log(`[categorical+ortho] errors=${n}`)
  expect(n).toBe(0)
})
