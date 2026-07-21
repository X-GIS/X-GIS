// #1229 batch-2 UI nets (items 3 + 4) — extends the toolbar-net class of
// specs (_snapshot-button / _mobile-monaco-collapse), NOT smoke (which is a
// hardware-GPU render-baseline spec).

import { test, expect } from '@playwright/test'

test('#1229 item 4 — [ / ] switch demos with the editor unfocused', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/demo.html?id=minimal&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
  // The select's VALUE carries the demo index (loadDemo rebuilds the option
  // list, so selectedIndex is not a stable observable).
  const val = () =>
    page.evaluate(() => (document.getElementById('demo-select') as HTMLSelectElement).value)
  const before = Number(await val())
  // Focus the canvas (not Monaco) and page through demos.
  await page.locator('#map').click({ position: { x: 10, y: 200 } })
  await page.keyboard.press(']')
  await page.waitForFunction(
    (b) => (document.getElementById('demo-select') as HTMLSelectElement).value === String(b + 1),
    before,
    { timeout: 20_000 },
  )
  await page.keyboard.press('[')
  await page.waitForFunction(
    (b) => (document.getElementById('demo-select') as HTMLSelectElement).value === String(b),
    before,
    { timeout: 20_000 },
  )
  expect(Number(await val())).toBe(before)
})

test('#1229 item 3 — gallery sections are #-linkable anchors', async ({ page }) => {
  await page.goto('/#cat-line', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#cat-line')
  // The section exists, carries the hover anchor link, and the deep link
  // scrolled it into view.
  const anchorHref = await page.locator('#cat-line .category-anchor').getAttribute('href')
  expect(anchorHref).toBe('#cat-line')
  const scrolled = await page.evaluate(() => window.scrollY)
  expect(scrolled).toBeGreaterThan(0)
})
