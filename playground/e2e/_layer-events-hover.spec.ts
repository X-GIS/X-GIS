// hover events end-to-end. mouseenter fires once when the pointer
// enters a feature, mouseleave fires once when it exits, mousemove
// fires while inside. Tracking is rAF-coalesced so a fast move doesn't
// produce a flood of events.

import { test, expect } from '@playwright/test'

test('mouseenter / mouseleave / mousemove fire correctly', async ({ page }) => {
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

  // Install listeners that record dispatch order. mouseenter / mouseleave
  // tracking with feature ids is the actual contract — each transition
  // between features in the SAME layer should fire leave-then-enter.
  await page.evaluate(() => {
    type Map = { getLayer(n: string): { addEventListener(t: string, h: (e: unknown) => void): void } | null }
    const m = (window as { __xgisMap?: Map }).__xgisMap!
    ;(window as { __log?: Array<{ type: string; id: number }> }).__log = []
    const log = (window as { __log?: Array<{ type: string; id: number }> }).__log!
    const fill = m.getLayer('fill')!
    fill.addEventListener('mouseenter', (e: unknown) => {
      log.push({ type: 'enter', id: (e as { feature: { id: number } }).feature.id })
    })
    fill.addEventListener('mouseleave', (e: unknown) => {
      log.push({ type: 'leave', id: (e as { feature: { id: number } }).feature.id })
    })
    fill.addEventListener('mousemove', (e: unknown) => {
      log.push({ type: 'move', id: (e as { feature: { id: number } }).feature.id })
    })
  })

  const rect = await page.evaluate(() => {
    const c = document.querySelector('#map') as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })

  // Move pointer over a feature. Earlier pickAt grids showed countries
  // around (260, 533) and (390, 533) — those are different featureIds
  // (155 vs 175 in our pick test), so a move between them is a layer-
  // internal feature transition that should fire leave+enter.
  await page.mouse.move(rect.left + 260, rect.top + 533)
  await page.waitForTimeout(300)
  // Move within the same feature — should generate mousemove only.
  await page.mouse.move(rect.left + 270, rect.top + 533)
  await page.waitForTimeout(300)
  // Cross to a different country (different featureId).
  await page.mouse.move(rect.left + 390, rect.top + 533)
  await page.waitForTimeout(300)
  // Move off into ocean (no feature) → mouseleave.
  await page.mouse.move(rect.left + rect.width - 5, rect.top + 5)
  await page.waitForTimeout(400)

  const log = await page.evaluate(() => (window as { __log?: Array<{ type: string; id: number }> }).__log ?? [])
  console.log('[layer-events-hover]', JSON.stringify(log))

  // Concrete contract:
  //  - At least one mouseenter (entry into the first feature).
  //  - At least one mouseleave (exit at the end of the sequence).
  //  - mouseenter and mouseleave counts balance per feature visit.
  const enters = log.filter(e => e.type === 'enter')
  const leaves = log.filter(e => e.type === 'leave')
  const moves = log.filter(e => e.type === 'move')

  expect(enters.length).toBeGreaterThan(0)
  expect(leaves.length).toBeGreaterThan(0)
  expect(moves.length).toBeGreaterThan(0)
  // Every leave is preceded by a matching enter for the same feature id
  // (within the recorded sequence). Stack-based check.
  const stack: number[] = []
  for (const ev of log) {
    if (ev.type === 'enter') stack.push(ev.id)
    else if (ev.type === 'leave') {
      expect(stack.length).toBeGreaterThan(0)
      expect(stack.pop()).toBe(ev.id)
    }
  }
  // mousemove only fires while a feature is being hovered, so move ids
  // must always match the currently-hovered feature.
  let currentHover: number | null = null
  for (const ev of log) {
    if (ev.type === 'enter') currentHover = ev.id
    else if (ev.type === 'leave') currentHover = null
    else if (ev.type === 'move') expect(ev.id).toBe(currentHover)
  }
})

test('preventDefault stops further listeners on the same layer', async ({ page }) => {
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
    ;(window as { __pdLog?: string[] }).__pdLog = []
    const log = (window as { __pdLog?: string[] }).__pdLog!
    const fill = m.getLayer('fill')!
    fill.addEventListener('click', (e: unknown) => {
      log.push('first')
      ;(e as { preventDefault(): void }).preventDefault()
    })
    fill.addEventListener('click', () => { log.push('second') })
  })

  // Known land sample at world view zoom 1.5 (matches the click spec).
  const target = await page.evaluate(() => {
    const c = document.querySelector('#map') as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    return { x: r.left + 260, y: r.top + 267 }
  })
  await page.mouse.click(target.x, target.y)
  await page.waitForTimeout(500)

  const log = await page.evaluate(() => (window as { __pdLog?: string[] }).__pdLog ?? [])
  console.log('[preventDefault]', JSON.stringify(log))
  expect(log).toEqual(['first'])
})
