// XGISLayer .style proxy — Phase 2 surface check.
// Verifies: getLayer returns a stable reference, .style setters mutate
// the underlying show, Object.assign bulk update works, resetStyle
// restores compiled defaults, pointerEvents accepts 'auto'/'none'.
//
// No visual asserts — Phase 2 is wiring only. Phase 3 lands the
// pointer-events writeMask:0 variant; Phase 4 lands the events.

import { test, expect } from '@playwright/test'

test('XGISLayer .style mutates show + reset restores defaults', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/demo.html?id=multi_layer&e2e=1#1.5/20/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
  await page.waitForTimeout(800)

  const result = await page.evaluate(() => {
    const m = (window as { __xgisMap?: { getLayer(name: string): unknown; getLayers(): unknown[] } }).__xgisMap
    if (!m) return { error: 'no map' }

    const fill = m.getLayer('fill') as null | {
      name: string
      id: number
      style: {
        opacity: number; fill: string | null; stroke: string | null
        strokeWidth: number; visible: boolean; pointerEvents: 'auto' | 'none'
      }
      addEventListener: (t: string, f: () => void) => void
      hasListeners?: (t: string) => boolean
      resetStyle: (k?: string) => void
    }
    if (!fill) return { error: 'no fill layer' }

    // Stable reference: a second getLayer returns the same instance.
    const sameRef = m.getLayer('fill') === fill

    // getLayers includes our fill layer at a stable id.
    const layerNames = m.getLayers().map((l: unknown) => (l as { name: string }).name)

    const initialOpacity = fill.style.opacity
    const initialFill = fill.style.fill
    const initialPickable = fill.style.pointerEvents

    // Single setter mutates show.
    fill.style.opacity = 0.42

    // Bulk Object.assign works because each property is an accessor.
    Object.assign(fill.style, { fill: '#abcdef', strokeWidth: 7 })

    const afterMutate = {
      opacity: fill.style.opacity,
      fill: fill.style.fill,
      strokeWidth: fill.style.strokeWidth,
    }

    // pointerEvents accepts 'none' / 'auto' and rejects bad values.
    let bad: string | null = null
    try { (fill.style as { pointerEvents: string }).pointerEvents = 'banana' }
    catch (e) { bad = (e as Error).message }
    fill.style.pointerEvents = 'none'
    const peNone = fill.style.pointerEvents
    fill.style.pointerEvents = 'auto'

    // resetStyle restores compiled defaults for each prop touched.
    fill.resetStyle()
    const afterReset = {
      opacity: fill.style.opacity,
      fill: fill.style.fill,
      strokeWidth: fill.style.strokeWidth,
    }

    // Listener registry surface — addEventListener is callable + idempotent;
    // Phase 4 wires actual dispatch.
    const handler = () => {}
    fill.addEventListener('click', handler)
    const hasClick = fill.hasListeners?.('click') ?? null

    return {
      sameRef,
      hasFill: layerNames.includes('fill'),
      fillId: fill.id,
      initialOpacity,
      initialFill,
      initialPickable,
      afterMutate,
      bad,
      peNone,
      afterReset,
      hasClick,
    }
  })

  console.log('[layer-style]', JSON.stringify(result, null, 2))
  expect(result.error).toBeUndefined()
  expect(result.sameRef).toBe(true)
  expect(result.hasFill).toBe(true)
  expect(result.fillId).toBeGreaterThan(0)
  expect(result.initialPickable).toBe('auto')
  expect(result.afterMutate.opacity).toBeCloseTo(0.42, 5)
  expect(result.afterMutate.fill).toBe('#abcdef')
  expect(result.afterMutate.strokeWidth).toBe(7)
  expect(result.bad).toMatch(/pointerEvents/)
  expect(result.peNone).toBe('none')
  expect(result.afterReset.opacity).toBeCloseTo(result.initialOpacity, 5)
  expect(result.afterReset.fill).toBe(result.initialFill)
  expect(result.hasClick).toBe(true)
})
