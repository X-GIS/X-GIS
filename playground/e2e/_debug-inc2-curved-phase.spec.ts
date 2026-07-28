import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__inc2-curved-phase__', process.env.INC2_TAG ?? 'run')
mkdirSync(OUT, { recursive: true })

// INC-2 render verification. Same settle-until-three-identical-hashes harness as
// _debug-inc1-phase.spec.ts, extended with PITCHED cameras — pitch is where the
// prefix-sum world↔screen mapping and INC-1's single-pxPerMeter scalar disagree,
// since the far end of a road compresses on screen while its mercator length does
// not. A flat-only sweep cannot tell the two apart.
const CAMERAS = [
  ['z16.7', '16.7/37.79172/126.79102'],
  ['z16.0', '16.0/37.79172/126.79102'],
  ['z16.7-p60', '16.7/37.79172/126.79102/0.0/60.0'],
  ['z16.0-p45b30', '16.0/37.79172/126.79102/30.0/45.0'],
]

for (const [tag, hash] of CAMERAS) {
  test(`inc2 curved phase ${tag}`, async ({ page }) => {
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
