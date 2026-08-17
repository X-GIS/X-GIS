import { test, expect, type Page } from '@playwright/test'

// ═══ WEBGL2 FRAME-CLOSE GATE (#1480) — a frame must FINISH, not merely start ═══
//
// `render()` opens a frame with `_stats.beginFrame()` and closes it, hundreds of lines
// later, with `_frameCount++` and `_stats.endFrame()`. For as long as the forced-WebGL2
// twin existed, the WebGL2 path returned BETWEEN those two points, so every frame began
// and none ever finished:
//
//     drawn 0/60 | inspectPipeline().frame 0 | frameTime 0.00 | drawCalls 0 | fps 0
//
// `_frameCount` frozen, `stats.fps` / `frameTime` dead, and `recentFlickers` permanently
// empty — the tile-flicker diagnostic reporting "clean" because it was never written.
// #1544 fixed it by deleting the twin; this gate exists so it cannot come back silently.
//
// ─── WHY THIS NEEDS ITS OWN GATE ──────────────────────────────────────────────────────
//
// Because ninety-odd registered render gates did not notice, for the whole life of the
// bug. They read one of two things, and the frozen accumulator is neither:
//
//   * PIXELS — a frame that returns early still DREW; only the bookkeeping was skipped.
//   * per-source `getDrawStats()` — owned by `FrameDrawStats` on the VT renderer, a
//     different object from `StatsTracker`, and it kept counting correctly throughout.
//
// So triangle counts, tile counts and every screenshot stayed truthful while `XGISMap.stats`
// was stale. Nothing that reads the rendered result can see this; only something that reads
// the frame ACCOUNTING can, which is what this file is.
//
//   HEADED=0 XGIS_SOFTWARE_GPU=1 playwright test _webgl2-frame-close-gate.spec.ts

/** Driven frames. Enough that a stuck counter is unambiguous, small enough to stay cheap. */
const FRAMES = 30

async function driveFrames(page: Page, n: number) {
  return await page.evaluate(async (count) => {
    const m = (
      window as unknown as {
        __xgisMap: {
          invalidate?: () => void
          stats: { frameTime: number; drawCalls: number }
          inspectPipeline(): unknown
          _frameCount: number
        }
      }
    ).__xgisMap
    const before = (m.inspectPipeline() as { frame: number }).frame
    const frameTimes: number[] = []
    for (let i = 0; i < count; i++) {
      m.invalidate?.()
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      frameTimes.push(m.stats.frameTime)
    }
    return {
      advanced: (m.inspectPipeline() as { frame: number }).frame - before,
      frameTimes,
      drawCalls: m.stats.drawCalls,
    }
  }, n)
}

test('a driven WebGL2 frame reaches the END of render(), not just the start (#1480)', async ({
  page,
}) => {
  test.setTimeout(4 * 60_000)
  await page.setViewportSize({ width: 430, height: 715 })
  await page.goto('/demo.html?id=physical_map&forcegl2=1&e2e=1#16/48.84778/2.33194/0/80', {
    waitUntil: 'load',
  })
  await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady, {
    timeout: 60_000,
  })

  // A silent fallback to another backend would green this gate while testing nothing —
  // and WebGL2 is the ONLY backend the bug ever affected (`asScreenPassDevice` narrows on
  // `backend === 'webgl2'`), so the assertion below is meaningless without it.
  const backend = await page.evaluate(
    () =>
      (window as unknown as { __xgisMap?: { ctx?: { rhi?: { backend?: string } } } }).__xgisMap?.ctx
        ?.rhi?.backend,
  )
  expect(backend, '`?forcegl2=1` must actually yield a WebGL2 device').toBe('webgl2')

  await page.waitForTimeout(6000)
  const r = await driveFrames(page, FRAMES)
  const moved = new Set(r.frameTimes).size
  console.log(
    `\n  backend=${backend} | frame advanced ${r.advanced}/${FRAMES}` +
      ` | frameTime ${moved} distinct value(s), min ${Math.min(...r.frameTimes).toFixed(2)} ms` +
      ` | drawCalls ${r.drawCalls}\n`,
  )

  // ① THE TAIL OF render() IS REACHED. `_frameCount++` sits past every early return, so a
  //    counter that does not move is a frame that began and did not finish. Not `=== FRAMES`:
  //    the loop may also render on its own (keep-warm re-arms), so extra frames are legal —
  //    zero, or fewer than driven, is not.
  expect(
    r.advanced,
    `${FRAMES} frames were driven but the frame counter advanced ${r.advanced} — render() is ` +
      `returning before \`_frameCount++\`, so every frame begins and none completes (#1480). ` +
      `Pixels and per-source getDrawStats() stay correct in this state; only this gate sees it.`,
  ).toBeGreaterThanOrEqual(FRAMES)

  // ② `endFrame()` SPECIFICALLY RAN. It is the sole writer of `frameTime`, so a value that
  //    never changes across 30 real frames is a stale read, not a steady one — that is the
  //    failure mode a bare `> 0` would miss, because a frozen `frameTime` keeps whatever the
  //    last completed frame left behind. Two SwiftShader frames costing bit-identical
  //    milliseconds is not a thing; 30 of them is not either.
  expect(
    moved,
    `frameTime never changed across ${FRAMES} frames (${r.frameTimes[0]} ms throughout) — ` +
      `\`_stats.endFrame()\` is not running, so fps / frameTime / bundleReplaysThisFrame / the ` +
      `heap deltas are all frozen at their last completed value`,
  ).toBeGreaterThan(1)
  expect(Math.min(...r.frameTimes), 'a completed frame has a positive duration').toBeGreaterThan(0)

  // ③ The per-frame accumulators survived to the read. `beginFrame()` zeroes `drawCalls` and
  //    the draw sites fill it back in; reading 0 after a driven frame means the frame was
  //    opened and abandoned.
  expect(r.drawCalls, 'a completed frame recorded at least one draw call').toBeGreaterThan(0)
})
