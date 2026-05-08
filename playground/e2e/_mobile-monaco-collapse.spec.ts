// Smoke test for the mobile-collapse Monaco UX. The editor pane should
// be collapsed by default on a phone viewport, the gear toggle should
// expand it, and tapping again should collapse back. Desktop viewport
// keeps the editor visible (no toggle button shown).
import { test, expect } from '@playwright/test'

test.describe('mobile editor collapse', () => {
  test('phone viewport: editor collapsed by default, toggle expands', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 },
    )

    // Editor pane DOES NOT have `.expanded` initially → monaco-container
    // is hidden by the CSS rule.
    const monacoVisible = async (): Promise<boolean> => {
      const display = await page.locator('#monaco-container').evaluate(
        (el) => window.getComputedStyle(el).display,
      )
      return display !== 'none'
    }

    expect(await monacoVisible(), 'monaco hidden on first paint').toBe(false)

    const toggle = page.locator('#editor-toggle')
    await expect(toggle).toBeVisible()
    await toggle.click()
    expect(await monacoVisible(), 'monaco visible after toggle').toBe(true)
    await toggle.click()
    expect(await monacoVisible(), 'monaco hidden after second toggle').toBe(false)
  })

  test('desktop viewport: editor visible, toggle hidden', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 },
    )

    // CSS hides .mobile-only on desktop → toggle is display:none.
    const toggleDisplay = await page.locator('#editor-toggle').evaluate(
      (el) => window.getComputedStyle(el).display,
    )
    expect(toggleDisplay).toBe('none')

    // Monaco container is visible (no `.expanded` class needed on desktop).
    const monacoDisplay = await page.locator('#monaco-container').evaluate(
      (el) => window.getComputedStyle(el).display,
    )
    expect(monacoDisplay).not.toBe('none')
  })
})
