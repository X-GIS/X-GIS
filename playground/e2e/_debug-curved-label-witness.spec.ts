import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__curved-label-witness__')
mkdirSync(OUT, { recursive: true })

// INC-4 witness hunt. The design doc's gate for the circle-chain collision model is
// "MapLibre drops Dogam-ro 도감로 at z16 and X-GIS must too" — a CURVED road label
// X-GIS draws where MapLibre does not. That observation predates INC-1/INC-2, which
// moved line-label placement substantially, and it no longer reproduces at the one
// camera it was recorded at. Before building INC-4 on it, sweep for a witness that
// still holds: without one there is no way to tell a real improvement from a
// plausible-looking change (CLAUDE.md §5).
//
// Wide sweep across the report area — the label set turns over with zoom (which
// road classes are labelled at all) far more than with a small pan, so the zooms
// carry most of the coverage and the pans probe tile-boundary effects.
const CAMERAS: [string, string][] = [
  ['z15.0', '15.0/37.79172/126.79102'],
  ['z15.5', '15.5/37.79172/126.79102'],
  ['z16.0', '16.0/37.79172/126.79102'],
  ['z16.5', '16.5/37.79172/126.79102'],
  ['z17.0', '17.0/37.79172/126.79102'],
  ['z17.5', '17.5/37.79172/126.79102'],
  ['z16.0-n', '16.0/37.80200/126.79102'],
  ['z16.0-s', '16.0/37.78100/126.79102'],
  ['z16.0-e', '16.0/37.79172/126.80500'],
  ['z16.0-w', '16.0/37.79172/126.77700'],
  ['z17.0-n', '17.0/37.79800/126.79102'],
  ['z17.0-e', '17.0/37.79172/126.79900'],
]

for (const [tag, hash] of CAMERAS) {
  test(`curved-label witness ${tag}`, async ({ page }) => {
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
