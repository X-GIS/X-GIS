import { test, expect, type Page } from '@playwright/test'

// #1480 — WebGL2 frame-closing BOOKKEEPING gate.
//
// The defect: `RenderLoop.render()` (map/src/render-loop.ts) used to take the
// forced-WebGL2 twin branch and `return` before the frame-CLOSING tail —
// `_frameCount++`, `_stats.endFrame()`, the tile counters, the flicker log —
// ever ran. Frames were opened (`beginFrame()`) every tick but never closed,
// so `inspectPipeline().frame` stayed frozen at 0 forever, `stats.frameTime` /
// `stats.fps` / `stats.drawCalls` stayed at their zero-initial values, and the
// flicker diagnostic silently read "clean" on the only backend CI's
// `render-gate` leg exercises. Measured symptom on the broken path: "drawn
// 0/60 | frameTime 0.00 | drawCalls 0" while frames were visibly starting.
//
// The defect is already fixed — #1544 (commit 6ffe514d) deleted the forced-
// WebGL2 twin branch outright; `?forcegl2=1` now runs the SAME unified RHI
// pass chain as WebGPU, so there is no early return left to skip the tail.
// This spec is the regression gate the issue asked for and that never
// existed before: drive N real frames on `?forcegl2=1` and assert the
// close-out bookkeeping actually ADVANCED. On the old broken path this is
// precisely the assertion that fails — `frame` delta would be 0 no matter
// how many frames were driven.
//
// Frame-pumping idiom follows `_1581-static-camera-render-gate.spec.ts`:
// `invalidate()` (marks `_needsRender`) + a short wait per iteration, since
// the idle-render skip (#929) means a static, non-animated scene renders
// nothing without an explicit invalidate.

type MapWin = {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisMap?: {
    invalidate?: () => void
    inspectPipeline?: () => { frame: number }
    stats?: { frameTime: number; fps: number; drawCalls: number }
    ctx?: { rhi?: { backend?: string } }
  }
}

const invalidate = (page: Page) =>
  page.evaluate(() => (window as unknown as MapWin).__xgisMap?.invalidate?.())

const readBookkeeping = (page: Page) =>
  page.evaluate(() => {
    const m = (window as unknown as MapWin).__xgisMap
    const frame = m?.inspectPipeline?.().frame ?? -1
    const stats = m?.stats
    return {
      frame,
      frameTime: stats?.frameTime ?? -1,
      fps: stats?.fps ?? -1,
      drawCalls: stats?.drawCalls ?? -1,
    }
  })

const N = 40

test('WebGL2 frame bookkeeping (#1480): frame/stats advance across N driven frames', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  await page.setViewportSize({ width: 600, height: 600 })
  // `debug=checker` supplies content (a sourceless `id=minimal` frame draws
  // nothing by design, #1041) so drawCalls has something real to count.
  await page.goto('/demo.html?id=minimal&forcegl2=1&e2e=1&debug=checker', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
    timeout: 30_000,
  })

  // Identity — this is the WebGL2 path the issue is about, not a fallback.
  const backend = await page.evaluate(() => (window as unknown as MapWin).__xgisActiveBackend)
  expect(backend, 'window.__xgisActiveBackend').toBe('webgl2')
  const rhiBackend = await page.evaluate(
    () => (window as unknown as MapWin).__xgisMap?.ctx?.rhi?.backend,
  )
  expect(rhiBackend, 'host.ctx.rhi.backend').toBe('webgl2')

  // Let the initial checker frame settle before the baseline read.
  await page.waitForTimeout(500)

  // NEGATIVE CONTROL — the bookkeeping is already alive at least once before
  // the driven loop starts. This rules out "the engine never renders at
  // all" as the reason a later zero-delta would read; the discriminator this
  // gate exists for is specifically that the bookkeeping FREEZES after
  // opening, not that it never opens.
  const before = await readBookkeeping(page)
  expect(before.frame, 'inspectPipeline().frame is live before the driven loop').toBeGreaterThan(0)
  expect(before.frameTime, 'stats.frameTime is live before the driven loop').toBeGreaterThan(0)

  // Drive N real frames.
  for (let i = 0; i < N; i++) {
    await invalidate(page)
    await page.waitForTimeout(30)
  }

  const after = await readBookkeeping(page)

  // The core discriminator (#1480): on the broken path `frame` never moves,
  // no matter how many frames are driven — this delta would be 0. Bounded
  // both ways so the assertion means "advanced roughly N times", not just
  // "advanced at all" (a 1-frame trickle would also pass a bare `> before`).
  const delta = after.frame - before.frame
  const deltaMsg = `inspectPipeline().frame advanced by ${delta} across ${N} driven frames`
  expect(delta, deltaMsg).toBeGreaterThanOrEqual(Math.floor(N * 0.5))
  expect(delta, deltaMsg).toBeLessThanOrEqual(N * 3)

  // `endFrame()` output — frozen at 0 on the broken path — is still live.
  expect(after.frameTime, 'stats.frameTime after the driven loop').toBeGreaterThan(0)
  expect(after.fps, 'stats.fps after the driven loop').toBeGreaterThan(0)
  expect(after.drawCalls, 'stats.drawCalls after the driven loop').toBeGreaterThan(0)

  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
})
