// Repro gate for issue #1153: in-page BACKEND SWITCH must not crash the site.
//
// The playground backend toggle does an in-page teardown: replaceMapCanvas()
// (fresh canvas node — context type is sticky) + runSource() re-run
// (demo-runner.ts:1434-1445). The reported production symptom is that a
// runtime backend change DOWNS the whole site. This spec drives the real
// toggle through webgpu -> webgl2 -> webgpu cycles and captures EVERY
// uncaught pageerror / console.error / page-death.
//
// Fail-before candidate: expected to FAIL while the crash exists; becomes the
// permanent gate once the teardown/error-boundary fix lands.
//
// Headed real GPU. Deterministic local demo (minimal, no network).

import { test, expect } from '@playwright/test'

type Win = Window & {
  __xgisReady?: boolean
  __xgisMap?: { invalidate?: () => void; ctx?: { rhi?: { backend?: string } } }
}

test('backend switch (in-page): no uncaught error, page stays alive', async ({ page }) => {
  test.setTimeout(240_000)

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`)
  })
  page.on('crash', () => errors.push('[PAGE CRASHED]'))

  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto('/demo.html?id=minimal#2/20/10/0/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, {
    timeout: 40_000,
  })
  const boot = await page.evaluate(() => {
    const w = window as unknown as Win
    return w.__xgisMap?.ctx?.rhi?.backend ?? 'unknown'
  })
  test.skip(boot !== 'webgpu', `needs a headed WebGPU boot (got ${boot})`)

  const preSwitch = errors.length

  // Drive the REAL toolbar toggle through cycles. selectOption fires the
  // 'change' listener -> replaceMapCanvas + runSource (the production path).
  const CYCLE = ['webgl2', 'webgpu', 'webgl2', '', 'webgpu'] as const
  for (const target of CYCLE) {
    await page.selectOption('#backend-select', target)
    await page.waitForTimeout(7000) // let teardown + new boot + first frames land
    const alive = await page.evaluate(() => 1 + 1).catch(() => null)
    const state = await page
      .evaluate(() => {
        const w = window as unknown as Win
        return {
          ready: w.__xgisReady === true,
          backend: w.__xgisMap?.ctx?.rhi?.backend ?? 'none',
        }
      })
      .catch(() => null)
    console.log(
      `[backend-switch] -> "${target || 'auto'}": alive=${alive === 2} state=${JSON.stringify(state)} errors=${errors.length}`,
    )
    if (alive !== 2) {
      errors.push(`[DEAD] page unresponsive after switching to "${target || 'auto'}"`)
      break
    }
  }

  const switchErrors = errors.slice(preSwitch)
  if (switchErrors.length > 0) {
    console.log(`[backend-switch] ${switchErrors.length} error(s) during switching:`)
    for (const e of switchErrors.slice(0, 15)) console.log('  ' + e)
  }
  expect(
    switchErrors,
    'in-page backend switching produced uncaught errors / page death (issue #1153)',
  ).toEqual([])
})
