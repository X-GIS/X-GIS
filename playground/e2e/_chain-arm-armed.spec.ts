// ═══ Is the chain-arm sweep ACTUALLY armed? (#1046 Inc-F2) ═══
//
// The twin-deletion fail-before is running the CI `?forcegl2=1` suite on the
// unified chain. Those specs type their own URLs and none of them asks for the
// chain, so the sweep arms it server-side instead: `XGIS_E2E_CHAIN=1` makes
// vite.config.ts inject `globalThis.__xgisRhiChain = true` into demo.html,
// which debug-flags.ts reads before the URL param.
//
// THE FAILURE MODE THIS EXISTS FOR: if that injection does not reach the page,
// every spec in the sweep boots the TWIN, they all pass — they always did — and
// the sweep reports the chain as fully verified while having measured nothing
// about it. Nothing else in the suite would notice. `webServer.reuseExistingServer`
// makes it easy to hit: a dev server already running without the env var is
// reused verbatim.
//
// So the sweep runs THIS first, and a red here invalidates the whole run.
// It asserts `window.__xgisFrameArm`, which the render loop writes from the
// branch it actually took (render-loop.ts) — not the flag, not the cap, both of
// which are also true on the twin arm.
//
// Run it in BOTH modes to prove it discriminates:
//   XGIS_E2E_CHAIN=1 → 'chain'   (the sweep is armed)
//   unset            → 'twin'    (the default is untouched)

import { test, expect } from '@playwright/test'

const ARMED = process.env.XGIS_E2E_CHAIN === '1'

test(`?forcegl2=1 runs the ${ARMED ? 'CHAIN' : 'TWIN'} frame (XGIS_E2E_CHAIN=${ARMED ? '1' : 'unset'})`, async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 900, height: 700 })
  // No `rhichain` in the URL — the whole point is what the SERVER armed.
  await page.goto('/demo.html?id=minimal&e2e=1&forcegl2=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 60_000 },
  )
  await page.waitForTimeout(1500)

  const observed = await page.evaluate(() => ({
    frameArm: (window as unknown as { __xgisFrameArm?: string }).__xgisFrameArm ?? null,
    mirror: (globalThis as { __xgisRhiChain?: boolean }).__xgisRhiChain === true,
    backend: (window as unknown as { __xgisMap?: { ctx?: { rhi?: { backend?: string } } } })
      .__xgisMap?.ctx?.rhi?.backend,
  }))
  console.log(`[chain-arm-armed] ${JSON.stringify(observed)}`)

  // The device must be WebGL2 either way — otherwise the sweep is measuring the
  // wrong backend and the arm question is moot.
  expect(observed.backend, 'device backend').toBe('webgl2')
  // The mirror check fires FIRST in the stale-server accident, so it — not the
  // frameArm one below — is the message an operator actually reads. It carries the
  // diagnosis (review F-6: verified by staging that accident, where only this line
  // printed).
  expect(
    observed.mirror,
    ARMED
      ? 'the server-side global mirror did NOT reach the page: this run is serving HTML with ' +
          'no injection, so every ?forcegl2 spec in it measured the TWIN. Almost always a dev ' +
          'server started WITHOUT XGIS_E2E_CHAIN=1 being handed back by ' +
          'webServer.reuseExistingServer — stop it (pkill -f "[v]ite") and re-run.'
      : 'the unarmed run must NOT see the mirror',
  ).toBe(ARMED)
  expect(
    observed.frameArm,
    ARMED
      ? 'ARMED SWEEP IS NOT ARMED: the loop ran the twin, so every ?forcegl2 spec in this ' +
          'run measured the twin and its green means nothing. Check that the dev server was ' +
          'started WITH XGIS_E2E_CHAIN=1 (webServer.reuseExistingServer can hand back an ' +
          'older one) before trusting any result from this invocation.'
      : 'the default (unarmed) run must still be the twin — otherwise this gate cannot tell ' +
          'the two apart and proves nothing when armed',
  ).toBe(ARMED ? 'chain' : 'twin')
})
