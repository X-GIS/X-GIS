// ═══ Globe background-pattern pixel gate (#1128 fence) ═══
//
// #1128 reported the synthetic earth-surface ignoring fillPattern on the
// sphere (solid disc, 0 pattern pixels). Fixed by #1154's world-band
// reinstall dispatch-list rebuild (the globe background-pattern's fresh show
// now reaches vectorTileShows). This gate fences the repair the same way
// #1168 fenced #1127: the fixture's red/blue checker must actually
// rasterise on the globe disc — draw-count coverage alone cannot see a
// solid-colour regression.

import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

async function pump(page: Page): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await page.evaluate(() =>
      (window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.(),
    )
    await page.waitForTimeout(80)
  }
}

test('background-pattern rasterises on the globe disc', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto(
    '/demo.html?id=fixture_bg_pattern&e2e=1&sprite=/fixture-sprite&proj=globe#1.2/20/10',
    {
      waitUntil: 'domcontentloaded',
    },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 60_000 },
  )
  await pump(page)
  const png = PNG.sync.read(await page.locator('#xg-canv, canvas').first().screenshot())
  let red = 0
  let blue = 0
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i]!
    const g = png.data[i + 1]!
    const b = png.data[i + 2]!
    if (r > 150 && g < 100 && b < 100) red++
    else if (b > 150 && r < 100) blue++
  }
  console.log(`[bg-pattern-globe] red=${red} blue=${blue}`)
  // Measured on the fix: red 38 917 / blue 38 928 over a ~81 000 px disc.
  // A solid-disc regression yields 0/0; require a decisive fraction of the
  // measured value so camera/AA drift can't flake the gate.
  expect(red).toBeGreaterThan(10_000)
  expect(blue).toBeGreaterThan(10_000)
})
