// Smoke test for the snapshot copy button.
// Click the button, then read the clipboard, verify the payload is
// a valid snapshot JSON (camera + viewport + tiles + renderOrder).

import { test, expect } from '@playwright/test'

test.describe('snapshot copy button', () => {
  test('click writes a valid snapshot JSON to the clipboard', async ({ browser }) => {
    test.setTimeout(60_000)
    // Grant clipboard permission to the page so navigator.clipboard
    // works in headless chromium.
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    const page = await ctx.newPage()
    await page.goto('/demo.html?id=osm_style#16/35.6585/139.7454/0/45', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 },
    )
    await page.waitForTimeout(5_000)

    const btn = page.locator('#snapshot-btn')
    await expect(btn).toBeVisible()
    await btn.click()

    // Wait for the button label to flip to "Copied X KB" — confirms
    // the click handler ran through to the success branch.
    await expect(btn.locator('#snapshot-btn-label')).toContainText(/Copied \d+ KB/, { timeout: 10_000 })
    await expect(btn).toHaveAttribute('data-state', 'ok')

    // Read clipboard, parse, sanity-check the snapshot fields.
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText())
    expect(clipboardText.length).toBeGreaterThan(100)
    const parsed = JSON.parse(clipboardText) as {
      schemaVersion: number
      pageUrl: string
      camera: { lon: number; lat: number; zoom: number }
      viewport: { width: number; height: number; dpr: number }
      pageViewport: { width: number; height: number }
      sources: Record<string, { tiles: Array<{ z: number; x: number; y: number }> }>
      renderOrder: unknown[]
      pixelHash: string
    }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.pageUrl).toContain('osm_style')
    expect(parsed.camera.zoom).toBeCloseTo(16, 1)
    expect(parsed.viewport.width).toBeGreaterThan(0)
    expect(parsed.pageViewport.width).toBe(1280)
    expect(Object.keys(parsed.sources).length).toBeGreaterThan(0)
    expect(parsed.renderOrder.length, 'snapshot must include render-order trace from the click-armed frame').toBeGreaterThan(0)
    expect(parsed.pixelHash.length).toBeGreaterThan(0)

    await ctx.close()
  })
})
