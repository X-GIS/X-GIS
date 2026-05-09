// Diagnostic perf spec — measures Bright at z=14 Tokyo with text
// subsystem KILLED via __xgisDisableLabels. Result tells us how much
// of the current 308ms/frame regression is text-side vs the rest of
// the renderer.

import { test } from '@playwright/test'
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(__dirname, '__convert-fixtures/bright.json'), 'utf8')

test('Bright pitch=0 z=14 — text DISABLED', async ({ page }) => {
  test.setTimeout(120_000)
  const xgis = convertMapboxStyle(fixture)

  await page.addInitScript((src: string) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'Bright (no-labels)')
    ;(window as unknown as { __xgisDisableLabels?: boolean }).__xgisDisableLabels = true
  }, xgis)

  await page.goto('/demo.html?id=__import#14/35.68/139.76/0/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(5_000)

  const sample = await page.evaluate(async () => {
    return await new Promise<{ frames: number[] }>((res) => {
      const frames: number[] = []
      let last = performance.now()
      const start = last
      const tick = () => {
        const now = performance.now()
        frames.push(now - last)
        last = now
        if (now - start < 3000) requestAnimationFrame(tick)
        else res({ frames })
      }
      requestAnimationFrame(tick)
    })
  })

  const sorted = [...sample.frames].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!
  // eslint-disable-next-line no-console
  console.log(`[no-labels] median=${median.toFixed(1)}ms (${(1000 / median).toFixed(0)} fps) p95=${p95.toFixed(1)}ms frames=${sample.frames.length}`)
})
