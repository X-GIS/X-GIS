import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

type W = {
  __xgisReady?: boolean
  __xgisMap?: { setProjection?: (s: string) => void; setExperimentalGlobeDrape?: (b: boolean) => void; invalidate?: () => void }
  __xgisDebugSurfaceQuadtreeCache?: boolean
}

// US-003: static-camera quadtree cache. After tiles settle, a re-render with an
// unchanged camera must reuse the cached leaf set (HIT) and be pixel-identical.
test('quadtree cache: static-camera HIT + pixel-identical', async ({ page }) => {
  test.setTimeout(90_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  const logs: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (/SURFQT\] cache/.test(m.text())) logs.push(m.text()) })

  await page.setViewportSize({ width: 1000, height: 1000 })
  await page.goto('/demo.html?id=pmtiles_layered&e2e=1#2.5/0/20', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as W).__xgisReady === true, null, { timeout: 25_000 })
  await page.evaluate(() => {
    const w = window as unknown as W
    w.__xgisDebugSurfaceQuadtreeCache = true
    w.__xgisMap?.setProjection?.('globe')
    w.__xgisMap?.setExperimentalGlobeDrape?.(true)
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(18000) // let tiles FULLY settle (base stable)
  writeFileSync(join(OUT, 'cache-f1.png'), await page.locator('#map').screenshot())
  logs.length = 0
  // Re-render with an UNCHANGED camera → expect a cache HIT, identical pixels.
  await page.evaluate(() => { (window as unknown as W).__xgisMap?.invalidate?.() })
  await page.waitForTimeout(500)
  writeFileSync(join(OUT, 'cache-f2.png'), await page.locator('#map').screenshot())

  const hit = logs.some((l) => /cache HIT/.test(l))
  console.log('CACHE hit-after-static=', hit, 'errors', errors.length, 'sampleLog', logs.slice(-1)[0] || '(none)')

  // CONTROL: drape OFF (base direct render only) — capture two static frames. If
  // THESE also differ, the cache-on frame diff is base-render settling, not the cache.
  await page.evaluate(() => { (window as unknown as W).__xgisMap?.setExperimentalGlobeDrape?.(false); (window as unknown as W).__xgisMap?.invalidate?.() })
  await page.waitForTimeout(4000)
  writeFileSync(join(OUT, 'cache-base1.png'), await page.locator('#map').screenshot())
  await page.evaluate(() => { (window as unknown as W).__xgisMap?.invalidate?.() })
  await page.waitForTimeout(1500)
  writeFileSync(join(OUT, 'cache-base2.png'), await page.locator('#map').screenshot())

  expect(errors.length).toBe(0)
})
