// Probe rendering against the protomaps v4 world-basemap archive
// (~176M tile entries, full world z=0..15). Uses an inline xgis source
// rather than pre-baked demo so URL can be swapped freely.

import { test, expect, type Page } from '@playwright/test'

const URL = 'https://demo-bucket.protomaps.com/v4.pmtiles'

async function waitForXgisReady(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 60_000 },
  )
}

async function captureCanvas(page: Page, name: string) {
  await page.locator('canvas#map').screenshot({ path: `test-results/pmtiles-v4-${name}.png` })
}

async function dumpDiag(page: Page, label: string, logs: string[]) {
  console.log(`\n=== [${label}] catalog state ===`)
  const state = await page.evaluate(() => {
    type Cat = { maxLevel: number; getBounds(): unknown; getCacheSize(): number; getPendingLoadCount(): number; hasData(): boolean }
    const m = (window as unknown as { __xgisMap?: { vtSources?: Map<string, { source: Cat }> } }).__xgisMap
    const e = m?.vtSources?.get('pm')
    return e ? {
      maxLevel: e.source.maxLevel,
      bounds: e.source.getBounds(),
      cacheSize: e.source.getCacheSize(),
      pending: e.source.getPendingLoadCount(),
      hasData: e.source.hasData(),
    } : null
  })
  console.log(JSON.stringify(state, null, 2))
  console.log(`=== [${label}] notable logs ===`)
  for (const l of logs) {
    if (l.includes('PMTiles') || l.includes('catalog') || l.includes('pmtiles') ||
        l.includes('error') || l.includes('Error') || l.includes('miss') ||
        l.includes('compile-null') || l.includes('frame-validation')) {
      console.log('  >', l)
    }
  }
}

test('protomaps v4: world z=2', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const logs: string[] = []
  page.on('console', msg => { logs.push(msg.text()) })
  page.on('pageerror', err => { logs.push(`PAGEERROR: ${err.message}`) })

  await page.goto(`/demo.html?id=pmtiles_v4#2/20/0`, { waitUntil: 'domcontentloaded' })
  try {
    await waitForXgisReady(page)
  } catch (e) {
    console.log(`[v4 world z=2] xgisReady TIMEOUT — dumping logs`)
    await dumpDiag(page, 'v4 world z=2 TIMEOUT', logs)
    throw e
  }
  await page.waitForTimeout(8000)  // archive header + low-z tiles

  await captureCanvas(page, 'world-z2')
  await dumpDiag(page, 'v4 world z=2', logs)
})

test('protomaps v4: Tokyo z=10', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const logs: string[] = []
  page.on('console', msg => { logs.push(msg.text()) })
  page.on('pageerror', err => { logs.push(`PAGEERROR: ${err.message}`) })

  await page.goto(`/demo.html?id=pmtiles_v4#10/35.68/139.76`, { waitUntil: 'domcontentloaded' })
  try {
    await waitForXgisReady(page)
  } catch (e) {
    console.log(`[v4 Tokyo z=10] xgisReady TIMEOUT — dumping logs`)
    await dumpDiag(page, 'v4 Tokyo z=10 TIMEOUT', logs)
    throw e
  }
  await page.waitForTimeout(8000)

  await captureCanvas(page, 'tokyo-z10')
  await dumpDiag(page, 'v4 tokyo z=10', logs)
})
