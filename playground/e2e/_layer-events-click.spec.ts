// click event end-to-end. Synthetic mouse click over the `fill` layer
// should fire the listener exactly once with the hit feature's id and
// projected coordinate.
//
// click latency note: pickAt is an async WebGPU readback (~1 frame),
// so the dispatcher fires asynchronously. The test awaits the listener
// via a Promise that resolves on first dispatch.

import { test, expect } from '@playwright/test'

test('layer.addEventListener("click", h) — fires with feature + coord', async ({ page }) => {
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

  // Install the listener on the page side. Stash the result on window
  // so the test can read it after the click round-trips through pickAt.
  await page.evaluate(() => {
    type Map = {
      getLayer(n: string): { addEventListener(t: string, h: (e: unknown) => void): void } | null
    }
    const m = (window as { __xgisMap?: Map }).__xgisMap!
    ;(window as { __clickEvents?: unknown[] }).__clickEvents = []
    m.getLayer('fill')!.addEventListener('click', (ev: unknown) => {
      const e = ev as {
        type: string; feature: { id: number; layer: string; properties: Record<string, unknown> }
        coordinate: [number, number]; pixel: [number, number]
      }
      ;(window as { __clickEvents?: unknown[] }).__clickEvents!.push({
        type: e.type, id: e.feature.id, layer: e.feature.layer,
        coord: e.coordinate, pixel: e.pixel,
        propsKeys: Object.keys(e.feature.properties ?? {}),
      })
    })
  })

  // Click on a known country position. _pick-e2e found hits at canvas-
  // relative (260, 267) — a reliable land sample at world view zoom 1.5.
  const target = await page.evaluate(() => {
    const c = document.querySelector('#map') as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    return { x: r.left + 260, y: r.top + 267 }
  })
  await page.mouse.click(target.x, target.y)

  // Wait up to 1s for the async dispatch.
  const events = await page.waitForFunction(
    () => {
      const arr = (window as { __clickEvents?: unknown[] }).__clickEvents
      return arr && arr.length > 0 ? arr : null
    },
    null, { timeout: 1500 },
  ).then(h => h.jsonValue() as Promise<Array<{
    type: string; id: number; layer: string; coord: [number, number]; pixel: [number, number]; propsKeys: string[]
  }>>)

  console.log('[layer-events-click]', JSON.stringify(events))
  expect(events.length).toBeGreaterThanOrEqual(1)
  const ev = events[0]
  expect(ev.type).toBe('click')
  expect(ev.layer).toBe('fill')
  expect(ev.id).toBeGreaterThan(0)
  // Coordinate at world-view zoom should be a sensible lng/lat.
  expect(ev.coord[0]).toBeGreaterThanOrEqual(-180)
  expect(ev.coord[0]).toBeLessThanOrEqual(180)
  expect(ev.coord[1]).toBeGreaterThanOrEqual(-85)
  expect(ev.coord[1]).toBeLessThanOrEqual(85)
  // Pixel is canvas-relative.
  expect(ev.pixel[0]).toBeGreaterThan(0)
  expect(ev.pixel[1]).toBeGreaterThan(0)
  // Properties from countries.geojson should at least include `name`.
  expect(ev.propsKeys.length).toBeGreaterThan(0)
})

test('drag past the click deadzone does NOT fire click', async ({ page }) => {
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
    type Map = { getLayer(n: string): { addEventListener(t: string, h: (e: unknown) => void): void } | null }
    const m = (window as { __xgisMap?: Map }).__xgisMap!
    ;(window as { __clickEvents?: unknown[] }).__clickEvents = []
    m.getLayer('fill')!.addEventListener('click', () => {
      ;(window as { __clickEvents?: unknown[] }).__clickEvents!.push({})
    })
  })

  const rect = await page.evaluate(() => {
    const c = document.querySelector('#map') as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  // 100px drag — well past the 4px click deadzone.
  await page.mouse.move(rect.x, rect.y)
  await page.mouse.down()
  await page.mouse.move(rect.x + 100, rect.y, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(500)

  const count = await page.evaluate(() => (window as { __clickEvents?: unknown[] }).__clickEvents?.length ?? 0)
  console.log(`[layer-events-click] drag click count: ${count}`)
  expect(count).toBe(0)
})
