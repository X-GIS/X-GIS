// ═══ pickAt on WebGL2 — the frame snapshot lives on the chain path (#1046 Inc-F) ═══
//
// The deleted forced-WebGL2 twin owned one thing the chain frame did not: the
// camera/projection snapshot `pickViaRhi` samples. That snapshot's home was moved
// above the twin/chain fork in Inc-F1, so a chain frame's pickAt no longer resolves
// to null — but the failure mode if that regressed is SILENT: no error, no blank
// frame, and nothing a pixel gate can see (the twin-parity fixtures ran with
// picking OFF, so a pixel diff is structurally blind to it).
//
// This used to be a TWO-ARM gate: the same 5×5 pickAt grid run on the twin and on
// the chain, asserting the results matched sample for sample — the strongest
// available check while a second frame shape existed to compare against. The twin
// was deleted in Inc-F3a and `_pick-gl2-gate.spec.ts` (the twin-only gate) retired
// with it; this is what remains — the chain arm plus its floors.
//
// `window.__xgisFrameArm` is still asserted even with one arm: it is the loop's own
// record of the branch it took, not merely of what was asked, so a routing
// regression that silently fell back to some other frame shape would still be
// caught rather than green because the URL was right.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) — GPU-less.

import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

type Pick = { featureId: number; layerId: number; instanceId: number } | null

async function pickGrid(
  page: Page,
): Promise<{ picks: Pick[]; frameArm: string | null; backend: string | null }> {
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/demo.html?id=multi_layer&e2e=1&picking=1&forcegl2=1#1.5/20/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )
  // Let the tiles converge at SwiftShader speed before sampling.
  await page.waitForTimeout(9000)
  await page.evaluate(() => (window as any).__xgisMap?.invalidate?.())
  await page.waitForTimeout(1500)
  return page.evaluate(async () => {
    const m = (window as any).__xgisMap
    const canvas = document.querySelector('#map') as HTMLCanvasElement
    const rect = canvas.getBoundingClientRect()
    const picks: Pick[] = []
    for (let iy = 1; iy <= 5; iy++) {
      for (let ix = 1; ix <= 5; ix++) {
        picks.push(
          await m.pickAt(rect.left + (rect.width * ix) / 6, rect.top + (rect.height * iy) / 6),
        )
      }
    }
    return {
      picks,
      frameArm: (window as any).__xgisFrameArm ?? null,
      backend: m?.ctx?.rhi?.backend ?? null,
    }
  })
}

test('pickAt on WebGL2 hits real features, sample for sample (?forcegl2=1)', async ({ page }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  const r = await pickGrid(page)
  expect(r.backend, 'device backend').toBe('webgl2')
  expect(
    r.frameArm,
    'the frame the loop ACTUALLY ran — a routing fallback must not green this on some ' +
      'other frame shape',
  ).toBe('chain')

  const hits = r.picks.filter((p) => p !== null)
  console.log(`[pick-gl2-chain] hits ${hits.length}/25`)
  expect(errors, 'no page/console errors').toEqual([])

  // Aliveness floor: enough hits, real feature ids, more than one distinct feature —
  // rules out "the whole grid landed on one giant polygon" reporting as a pass.
  expect(
    hits.length,
    'pick hits (0 = the frame snapshot never reached the chain)',
  ).toBeGreaterThanOrEqual(5)
  for (const h of hits) expect(h!.featureId).toBeGreaterThan(0)
  expect(new Set(hits.map((h) => h!.featureId)).size).toBeGreaterThanOrEqual(2)
})
