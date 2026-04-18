// Visual capture for two reported line-renderer regressions:
//   1. Dash-offset animation makes line caps blink in/out
//   2. stroke-offset round-join produces a gap / wrong shape
// Takes screenshots at multiple animation phases so the cap-blink
// case is caught across frames.

import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__line-regressions__')
mkdirSync(ART, { recursive: true })

const CASES = [
  { id: 'fixture_anim_dashoffset', frames: 8, label: 'dash-anim' },
  { id: 'fixture_dashed_line', frames: 1, label: 'dash-static' },
  { id: 'fixture_stroke_outset', frames: 1, label: 'stroke-outset' },
  { id: 'fixture_stroke_offset_right', frames: 1, label: 'stroke-offset-right' },
  { id: 'fixture_join_round', frames: 1, label: 'join-round' },
]

for (const c of CASES) {
  test(`capture: ${c.label}`, async ({ page }) => {
    test.setTimeout(30_000)
    await page.setViewportSize({ width: 800, height: 600 })
    await page.goto(`/demo.html?id=${c.id}&e2e=1`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 15_000 },
    )
    await page.waitForTimeout(400)
    // Animation fixtures need multiple captures through a full cycle
    // (animation-duration-1500 = 1.5 s) so we see the whole phase space.
    for (let i = 0; i < c.frames; i++) {
      if (c.frames > 1) await page.waitForTimeout(180)
      const png = await page.locator('#map').screenshot()
      const name = c.frames > 1 ? `${c.label}-f${i}.png` : `${c.label}.png`
      writeFileSync(join(ART, name), png)
    }
  })
}
