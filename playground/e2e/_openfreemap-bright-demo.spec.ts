// Smoke test for the registered openfreemap_bright demo entry.
// Loads via the regular demo path (?id=openfreemap_bright) — no
// sessionStorage hand-off — so this tests the whole "permanent
// example" workflow exactly the way a user would hit it from the
// dropdown or a deep link.

import { test, expect } from '@playwright/test'

test('openfreemap_bright demo loads and renders at Tokyo z=14', async ({ page }) => {
  test.setTimeout(60_000)

  const consoleErrors: string[] = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  await page.goto('/demo.html?id=openfreemap_bright#14/35.68/139.76/0/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(6_000)

  const title = await page.title()
  expect(title).toContain('Bright')

  // Filter out known-irrelevant noise (CORS / WebGPU adapter / favicon).
  const ignorable = (s: string) =>
    /favicon|DevTools|WebGPU adapter|Failed to fetch.*openfreemap/i.test(s)
  const realErrors = consoleErrors.filter(s => !ignorable(s))
  expect(realErrors, 'no compile or runtime errors should fire').toEqual([])

  await page.locator('#map').screenshot({ path: 'test-results/openfreemap-bright-demo.png' })
})
