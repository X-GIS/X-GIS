// LOCAL-ONLY fill-pattern render smoke (real GPU). NOT a CI test.
//
// Renders fill-pattern via the Mapbox converter (`__xgisImportMapbox`) with an inline polygon
// (data URL) + a local sprite, then asserts the pattern routes through the RHI Material seam
// (§4 closed): the fill-pattern UV resolves, the RHI fill-draw counter advances, and NO page /
// console error fires (a fail-closed throw from recordFillDraw would surface here). Requires the
// dead-layer-elim fillPattern guard (else the pattern layer is dropped → solid fallback).
//
//   cd playground
//   ./node_modules/.bin/playwright test e2e/_fill-pattern-dc0.spec.ts --headed --reporter=line

import { test, expect } from '@playwright/test'

type W = {
  __xgisReady?: boolean
  __xgisVtrFillRhiDraws?: number
  __xgisMap?: {
    showCommands?: Array<{ fillPattern?: unknown; fillPatternUV?: unknown }>
  }
}

test('fill-pattern routes through the RHI seam (local, real-GPU)', async ({ page }) => {
  test.setTimeout(70_000)
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text())
  })
  await page.setViewportSize({ width: 600, height: 600 })
  await page.goto('/demo.html?id=fixture_fill_pattern&e2e=1&sprite=/fixture-sprite', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as W).__xgisReady === true, null, {
    timeout: 30_000,
  })

  await page.evaluate(() =>
    (window as unknown as { __xgisMap?: { jumpTo?: (o: object) => void } }).__xgisMap?.jumpTo?.({
      center: [0, 0],
      zoom: 1.5,
    }),
  )
  const uvResolved = await page
    .waitForFunction(
      () => {
        const shows = (window as unknown as W).__xgisMap?.showCommands ?? []
        return shows.some((s) => s.fillPattern != null && s.fillPatternUV != null)
      },
      null,
      { timeout: 25_000 },
    )
    .then(() => true)
    .catch(() => false)

  const drawsRhi = await page.evaluate(() => (window as unknown as W).__xgisVtrFillRhiDraws ?? 0)
  console.log(`uvResolved=${uvResolved} fillRhiDraws=${drawsRhi} pageErrors=${errs.length}`)

  expect(uvResolved, 'fill-pattern UV must resolve (pattern path exercised)').toBe(true)
  expect(drawsRhi, 'pattern fill must route through the RHI seam').toBeGreaterThan(0)
  expect(
    errs,
    `no page/console error (a fail-closed recordFillDraw throw would surface here): ${errs.join(' | ')}`,
  ).toHaveLength(0)
})
