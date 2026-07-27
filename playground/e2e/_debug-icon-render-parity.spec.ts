import { test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TAG = process.env.ICON_PARITY_TAG ?? 'x'
const OUT = join(HERE, '__icon-render-parity__')
mkdirSync(OUT, { recursive: true })

// Render gate for the #417 collide-overlap grid: the accelerator must not move
// a single pixel. Captures the X-GIS pane on collide-icon-heavy cameras; the
// before/after pair is compared with a directional pixel diff.
const CAMS = [
  { name: 'seoul-bright-z16', style: 'openfreemap-bright', hash: '#16/37.5665/126.9780' },
  { name: 'seoul-liberty-z17', style: 'openfreemap-liberty', hash: '#17/37.5665/126.9780/0/60' },
]

/** Capture once the frame STOPS CHANGING, not after a fixed wait. A fixed wait
 *  made this harness useless as a gate: a tile that had not landed at capture
 *  time swung the same-code diff to 11.8 % of the frame (whole building blocks
 *  present in one run, absent in the next), which buries any real regression.
 *  Samples the pane until `stable` consecutive screenshots hash identically. */
async function settledShot(page: Page, stable = 3, everyMs = 2500, maxMs = 120_000) {
  const pane = page.locator('#panes .pane').nth(1)
  const started = Date.now()
  let last = ''
  let run = 0
  let shot = await pane.screenshot()
  for (;;) {
    const h = createHash('sha1').update(shot).digest('hex')
    run = h === last ? run + 1 : 0
    last = h
    if (run + 1 >= stable) return shot
    if (Date.now() - started > maxMs) {
      console.log(`settle timeout after ${maxMs} ms — capturing the last frame`)
      return shot
    }
    await page.waitForTimeout(everyMs)
    shot = await pane.screenshot()
  }
}

for (const cam of CAMS) {
  test(`icon render ${cam.name}`, async ({ page }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1800, height: 900 })
    await page.goto(`/compare.html?style=${cam.style}${cam.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 60_000 },
    )
    await page.waitForTimeout(8_000)
    writeFileSync(join(OUT, `${cam.name}-${TAG}.png`), await settledShot(page))
  })
}
