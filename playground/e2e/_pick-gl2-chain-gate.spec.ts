// ═══ pickAt survives the chain flip — TWO-ARM pick parity on WebGL2 (#1046 Inc-F) ═══
//
// The twin owned one thing the chain frame did not: the camera/projection snapshot
// `pickViaRhi` samples. Written only inside renderFrameViaRhi, it stayed null on a
// chain frame, so every pickAt resolved to null — picking dead SILENTLY, with no
// error, no blank frame, and nothing a pixel gate can see (the twin-parity fixtures
// run with picking OFF, so DC=0 is structurally blind to it). That is the trap the
// twin-deletion plan names first.
//
// This gate runs the SAME 5×5 pickAt grid on BOTH arms and asserts the results are
// EQUAL, coordinate by coordinate — not merely that each arm hits something. A hit
// FLOOR only proves aliveness; two arms could both "work" while disagreeing about
// which feature is under the cursor, and after the twin is deleted there is nothing
// left to compare against. The comparison is only possible while both shapes exist,
// so it is made here, once, at full strength. RETIRE _pick-gl2-gate.spec.ts (the
// twin-only gate) and the twin arm below when renderFrameViaRhi is deleted; what
// remains is the chain arm plus its floors.
//
// ARM DISCRIMINATION: the routing flag and `caps.chainFrame` are BOTH true on the
// twin arm as well (the flag says what was asked; the cap is a frozen device
// constant), so asserting them proves nothing about which frame shape ran — a
// routing regression would land silently on the twin, whose picking works, and green
// the gate. Each arm therefore asserts `window.__xgisFrameArm`, which the render loop
// writes from the branch it actually took.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) — GPU-less.

import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

type Pick = { featureId: number; layerId: number; instanceId: number } | null

async function pickGrid(
  page: Page,
  arm: 'twin' | 'chain',
): Promise<{ picks: Pick[]; frameArm: string | null; backend: string | null }> {
  const chain = arm === 'chain' ? '&rhichain=1' : ''
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto(`/demo.html?id=multi_layer&e2e=1&picking=1&forcegl2=1${chain}#1.5/20/0`, {
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

test('pickAt on the CHAIN arm matches the twin, sample for sample (?forcegl2=1)', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  const watch = (p: Page): void => {
    p.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
    p.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
        errors.push(m.text().slice(0, 300))
    })
  }
  watch(page)

  const twin = await pickGrid(page, 'twin')
  expect(twin.backend, 'twin arm device backend').toBe('webgl2')
  expect(twin.frameArm, 'the frame the loop ACTUALLY ran (twin arm)').toBe('twin')

  const chainPage = await context.newPage()
  watch(chainPage)
  const chain = await pickGrid(chainPage, 'chain')
  expect(chain.backend, 'chain arm device backend').toBe('webgl2')
  expect(chain.frameArm, 'the frame the loop ACTUALLY ran (chain arm)').toBe('chain')

  const hits = chain.picks.filter((p) => p !== null)
  console.log(
    `[pick-gl2-chain] chain hits ${hits.length}/25, twin hits ${twin.picks.filter((p) => p !== null).length}/25`,
  )
  expect(errors, 'no page/console errors on either arm').toEqual([])

  // Aliveness floor first, so a total pick failure reports as itself rather than as
  // "both arms agree on 25 nulls" — the equality below is satisfied by two dead arms.
  expect(
    hits.length,
    'chain-arm pick hits (0 = the frame snapshot never reached the chain)',
  ).toBeGreaterThanOrEqual(5)
  for (const h of hits) expect(h!.featureId).toBeGreaterThan(0)
  expect(new Set(hits.map((h) => h!.featureId)).size).toBeGreaterThanOrEqual(2)

  // THE parity assertion: same coordinates, same features, same layers, same order.
  expect(chain.picks, 'chain-vs-twin pickAt results, sample for sample').toEqual(twin.picks)
})
