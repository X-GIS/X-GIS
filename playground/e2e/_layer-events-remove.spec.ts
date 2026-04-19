// removeEventListener / { once } / { signal } end-to-end. Verifies the
// listener registry tracks original-listener identity correctly so users
// can unregister handlers that the runtime internally wraps for `once`.

import { test, expect } from '@playwright/test'

const TARGET_X = 260
const TARGET_Y = 267

test('removeEventListener unregisters plain listeners', async ({ page }) => {
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
    type L = { addEventListener(t: string, h: (e: unknown) => void): void; removeEventListener(t: string, h: (e: unknown) => void): void }
    const m = (window as { __xgisMap?: { getLayer(n: string): L | null } }).__xgisMap!
    ;(window as { __log?: string[] }).__log = []
    const log = (window as { __log?: string[] }).__log!
    const fill = m.getLayer('fill')!
    const handler = () => log.push('fired')
    fill.addEventListener('click', handler)
    // Re-registering the same listener is a no-op (DOM semantics).
    fill.addEventListener('click', handler)
    fill.removeEventListener('click', handler)
  })

  const target = await page.evaluate(() => {
    const c = document.querySelector('#map') as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    return { x: r.left + 260, y: r.top + 267 }
  })
  await page.mouse.click(target.x, target.y)
  await page.waitForTimeout(500)

  const log = await page.evaluate(() => (window as { __log?: string[] }).__log ?? [])
  expect(log).toEqual([])
})

test('{ once: true } self-removes after first fire', async ({ page }) => {
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
    type L = { addEventListener(t: string, h: (e: unknown) => void, opt?: { once: boolean }): void }
    const m = (window as { __xgisMap?: { getLayer(n: string): L | null } }).__xgisMap!
    ;(window as { __log?: string[] }).__log = []
    const log = (window as { __log?: string[] }).__log!
    m.getLayer('fill')!.addEventListener('click', () => log.push('once'), { once: true })
  })

  const target = await page.evaluate(() => {
    const c = document.querySelector('#map') as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    return { x: r.left + 260, y: r.top + 267 }
  })
  await page.mouse.click(target.x, target.y)
  await page.waitForTimeout(500)
  await page.mouse.click(target.x, target.y)
  await page.waitForTimeout(500)

  const log = await page.evaluate(() => (window as { __log?: string[] }).__log ?? [])
  expect(log).toEqual(['once'])
})

test('removeEventListener unregisters a { once } handler before first fire', async ({ page }) => {
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
    type L = { addEventListener(t: string, h: (e: unknown) => void, opt?: { once: boolean }): void; removeEventListener(t: string, h: (e: unknown) => void): void }
    const m = (window as { __xgisMap?: { getLayer(n: string): L | null } }).__xgisMap!
    ;(window as { __log?: string[] }).__log = []
    const log = (window as { __log?: string[] }).__log!
    const handler = () => log.push('fired')
    const fill = m.getLayer('fill')!
    // The runtime wraps `handler` for once-tracking; remove must still
    // resolve via the original listener identity.
    fill.addEventListener('click', handler, { once: true })
    fill.removeEventListener('click', handler)
  })

  const target = await page.evaluate(() => {
    const c = document.querySelector('#map') as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    return { x: r.left + 260, y: r.top + 267 }
  })
  await page.mouse.click(target.x, target.y)
  await page.waitForTimeout(500)

  const log = await page.evaluate(() => (window as { __log?: string[] }).__log ?? [])
  expect(log).toEqual([])
})

test('AbortSignal aborts before first fire', async ({ page }) => {
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
    type L = { addEventListener(t: string, h: (e: unknown) => void, opt?: { signal: AbortSignal }): void }
    const m = (window as { __xgisMap?: { getLayer(n: string): L | null } }).__xgisMap!
    ;(window as { __log?: string[] }).__log = []
    const log = (window as { __log?: string[] }).__log!
    const ac = new AbortController()
    m.getLayer('fill')!.addEventListener('click', () => log.push('fired'), { signal: ac.signal })
    ac.abort()
  })

  const target = await page.evaluate(() => {
    const c = document.querySelector('#map') as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    return { x: r.left + 260, y: r.top + 267 }
  })
  await page.mouse.click(target.x, target.y)
  await page.waitForTimeout(500)

  const log = await page.evaluate(() => (window as { __log?: string[] }).__log ?? [])
  expect(log).toEqual([])
})
