import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__inc1-phase__', process.env.INC1_TAG ?? 'run')
mkdirSync(OUT, { recursive: true })

// INC-1 render verification. Captures the ML pane and the X-GIS pane at the
// report camera and its neighbours, settling until three consecutive frames hash
// identically — a fixed wait let a late tile swing same-code diffs by 11.8 % of
// frame in an earlier round, which is noise a directional gate must not read as
// signal.
const CAMERAS = [
  ['z16.7', '16.7/37.79172/126.79102'],
  ['z16.0', '16.0/37.79172/126.79102'],
  ['z16.9', '16.9/37.79172/126.79102'],
]

for (const [tag, hash] of CAMERAS) {
  test(`inc1 phase ${tag}`, async ({ page }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1800, height: 900 })
    await page.goto(`/compare.html?style=openfreemap-positron#${hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
        return w.__xgisReady === true && w.__mlReady === true
      },
      null,
      { timeout: 60_000 },
    )
    const panes = page.locator('#panes .pane')
    // Settle: sample until the X-GIS pane hashes identically three times running.
    let last = ''
    let stable = 0
    let shot = await panes.nth(1).screenshot()
    for (let i = 0; i < 40 && stable < 3; i++) {
      await page.waitForTimeout(1500)
      shot = await panes.nth(1).screenshot()
      const h = createHash('md5').update(shot).digest('hex')
      stable = h === last ? stable + 1 : 0
      last = h
    }
    writeFileSync(join(OUT, `${tag}-xg.png`), shot)
    writeFileSync(join(OUT, `${tag}-ml.png`), await panes.nth(0).screenshot())
  })
}
