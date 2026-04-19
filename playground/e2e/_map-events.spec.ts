// Map-level event delegation. `map.addEventListener` fires for any
// layer hit, with `event.target` pointing at the hit XGISLayer.
// Layer-level handlers run first; preventDefault on layer event
// suppresses map-level dispatch for that hit.

import { test, expect } from '@playwright/test'

const TARGET_X = 260
const TARGET_Y = 267

test('map.addEventListener("click", h) fires with event.target = layer', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/demo.html?id=multi_layer&e2e=1&picking=1#1.5/20/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
  await page.waitForTimeout(1500)

  await page.evaluate(() => {
    type Map = { addEventListener(t: string, h: (e: unknown) => void): void }
    const m = (window as { __xgisMap?: Map }).__xgisMap!
    ;(window as { __log?: Array<{ target: string; id: number }> }).__log = []
    const log = (window as { __log?: Array<{ target: string; id: number }> }).__log!
    m.addEventListener('click', (e: unknown) => {
      const ev = e as { target: { name: string }; feature: { id: number } }
      log.push({ target: ev.target.name, id: ev.feature.id })
    })
  })

  const target = await page.evaluate(() => {
    const c = document.querySelector('#map') as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    return { x: r.left + 260, y: r.top + 267 }
  })
  await page.mouse.click(target.x, target.y)
  await page.waitForTimeout(500)

  const log = await page.evaluate(() => (window as { __log?: Array<{ target: string; id: number }> }).__log ?? [])
  console.log('[map-events]', JSON.stringify(log))
  expect(log.length).toBeGreaterThanOrEqual(1)
  expect(log[0].target).toBe('fill')
  expect(log[0].id).toBeGreaterThan(0)
})

test('layer preventDefault suppresses map-level delegation', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/demo.html?id=multi_layer&e2e=1&picking=1#1.5/20/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
  await page.waitForTimeout(1500)

  await page.evaluate(() => {
    type Map = {
      addEventListener(t: string, h: (e: unknown) => void): void
      getLayer(n: string): { addEventListener(t: string, h: (e: unknown) => void): void } | null
    }
    const m = (window as { __xgisMap?: Map }).__xgisMap!
    ;(window as { __log?: string[] }).__log = []
    const log = (window as { __log?: string[] }).__log!
    m.getLayer('fill')!.addEventListener('click', (e: unknown) => {
      log.push('layer')
      ;(e as { preventDefault(): void }).preventDefault()
    })
    m.addEventListener('click', () => log.push('map'))
  })

  const target = await page.evaluate(() => {
    const c = document.querySelector('#map') as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    return { x: r.left + 260, y: r.top + 267 }
  })
  await page.mouse.click(target.x, target.y)
  await page.waitForTimeout(500)

  const log = await page.evaluate(() => (window as { __log?: string[] }).__log ?? [])
  console.log('[map-events]', JSON.stringify(log))
  expect(log).toEqual(['layer'])
})

test('pointerdown / pointerup fire on the hit layer', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/demo.html?id=multi_layer&e2e=1&picking=1#1.5/20/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
  await page.waitForTimeout(1500)

  await page.evaluate(() => {
    type L = { addEventListener(t: string, h: (e: unknown) => void): void }
    const m = (window as { __xgisMap?: { getLayer(n: string): L | null } }).__xgisMap!
    ;(window as { __log?: string[] }).__log = []
    const log = (window as { __log?: string[] }).__log!
    const fill = m.getLayer('fill')!
    fill.addEventListener('pointerdown', () => log.push('down'))
    fill.addEventListener('pointerup', () => log.push('up'))
  })

  const target = await page.evaluate(() => {
    const c = document.querySelector('#map') as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    return { x: r.left + 260, y: r.top + 267 }
  })
  // page.mouse.click → mousedown + mouseup → pointerdown + pointerup.
  await page.mouse.click(target.x, target.y)
  await page.waitForTimeout(500)

  const log = await page.evaluate(() => (window as { __log?: string[] }).__log ?? [])
  console.log('[map-events] pd/pu', JSON.stringify(log))
  // Both fire at least once; order is down-then-up. (Async pickAt may
  // reorder slightly, but a single click is small enough that both
  // resolve in flight order.)
  expect(log).toContain('down')
  expect(log).toContain('up')
})
