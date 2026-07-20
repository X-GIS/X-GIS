// ═══ Gallery XGIS/JS tab gate (#1194 A3b) ═══
//
// For a demo WITH a twin-corpus entry the header shows the XGIS/JS tab pair;
// the JS view displays the SceneBuilder construction EXTRACTED FROM THE
// CORPUS RAW SOURCE (single authority — the same code the parity gate pins),
// read-only, with Run disabled. For a demo WITHOUT a twin the tabs hide.
// Console must stay free of errors (the 'typescript' Monaco model runs with
// the language service disabled — a worker mismatch would surface here).

import { test, expect } from '@playwright/test'

test('JS tab shows the corpus construction for twin demos, hides otherwise', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('console', (msg) => {
    // Network-blocked container: external fetches (fonts/tiles) reset — not
    // an app error. Keep every real JS error (the Monaco worker-mismatch
    // class this gate exists for surfaces as an uncaught Error).
    if (msg.type() === 'error' && !msg.text().includes('Failed to load resource'))
      errors.push(msg.text())
  })

  await page.goto('/demo.html?id=minimal&e2e=1&forcegl2=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )

  const tabs = page.locator('#lang-tabs')
  await expect(tabs).toBeVisible()

  await page.locator('#tab-js').click()
  // Monaco renders indentation as NBSP — normalise before substring checks.
  const editorText = () =>
    page.evaluate(() =>
      document.querySelector('.editor-body')?.textContent?.replace(/\u00a0/g, ' '),
    )
  await expect.poll(editorText).toContain("import { SceneBuilder, ident } from '@xgis/compiler'")
  expect(await editorText()).toContain('new SceneBuilder()')
  expect(await editorText()).toContain('await map.runScene(scene)')
  await expect(page.locator('#run-btn')).toBeDisabled()

  await page.locator('#tab-xgis').click()
  await expect.poll(editorText).toContain('source world')
  await expect(page.locator('#run-btn')).toBeEnabled()

  // Demo without a twin → tabs hidden (navigate via the same page).
  await page.goto('/demo.html?id=dark&e2e=1&forcegl2=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )
  await expect(page.locator('#lang-tabs')).toBeHidden()

  expect(errors).toEqual([])
})
