import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'

const OUT = 'D:/X-GIS/tmp/shots'
const STYLE = process.env.CAP_STYLE ?? 'openfreemap-positron'
const HASH = process.env.CAP_HASH ?? '#13.75/37.24338/131.87125'
const PROJ = process.env.CAP_PROJ ? `&proj=${process.env.CAP_PROJ}` : ''
const TAG = process.env.CAP_TAG ?? 'cap'

test('capture compare panes', async ({ page }) => {
  mkdirSync(OUT, { recursive: true })
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push('[PAGEERROR] ' + e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push('[err] ' + m.text().slice(0, 240))
  })
  await page.goto(`/compare.html?style=${STYLE}${PROJ}${HASH}`)
  await page.waitForFunction(
    () => (window as any).__xgisReady === true && (window as any).__mlReady === true,
    null,
    { timeout: 40_000 },
  )
  await page.evaluate(
    () =>
      new Promise<void>((res) => {
        const m = (window as any).__xgisMap
        const t0 = performance.now()
        let s = 0
        const tick = () => {
          let ok = false
          try {
            ok = m?.hasPendingSourceWork?.() === false
          } catch {}
          s = ok ? s + 1 : 0
          s >= 8 || performance.now() - t0 > 15_000 ? res() : requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
  await page.waitForTimeout(2500)
  const panes = page.locator('#panes .pane')
  writeFileSync(`${OUT}/${TAG}_ml.png`, await panes.nth(0).screenshot())
  writeFileSync(`${OUT}/${TAG}_xg.png`, await panes.nth(1).screenshot())
  console.log(`[CAP] ${TAG} style=${STYLE} proj=${PROJ || 'flat'} errors=${errs.length}`)
  for (const e of errs.slice(0, 12)) console.log(e)
})
