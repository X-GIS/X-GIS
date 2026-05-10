// Mobile-class GPU bottleneck reproducer — desktop measurement.
//
// User report (iPhone Pro DPR=3): osm_style at zoom=16.18 / pitch=77.2°
// over Manhattan. Inspector showed:
//   * fps 15 / frame ms 67 / gpu pass 67 ms (= GPU bound)
//   * tilesVis 304, drawCalls 375, triangles 2.4 M, lines 223 k
//   * heat + battery drain
//
// Hypothesis: high pitch makes the SSE selector emit horizon tiles
// at z=8-9 even when each is <4 px on screen. Sub-pixel tiles waste
// fragment shader work + draw-call overhead; culling them drops
// tilesVis dramatically with no visual loss.
//
// This spec measures the EXACT user camera state (Manhattan z=16.18
// pitch=77.2 bearing=332.3) on osm_style and reports per-source
// drawStats + per-frame deltas. It's a desktop measurement (no DPR
// emulation — iPhone numbers will be ~3× higher proportionally) but
// the relative before/after delta from the cull lands the same way.

import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

const URL_HASH = '#16.18/40.76602/-73.97986/332.3/77.2'

interface VTRStats {
  sourceName: string
  tilesVisible: number
  drawCalls: number
  missedTiles: number
  triangles: number
  lines: number
}

test('osm_style high-pitch Manhattan — baseline tile + frame stats', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  await page.goto(`/demo.html?id=osm_style${URL_HASH}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 60_000 },
  )
  // Settle initial cascade.
  await page.waitForFunction(() => {
    const map = (window as unknown as { __xgisMap?: { vtSources: Map<string, unknown> } }).__xgisMap
    if (!map?.vtSources) return false
    let v = 0
    for (const entry of map.vtSources.values()) {
      const r = entry as { renderer?: { getDrawStats?: () => { tilesVisible: number } } }
      v += r.renderer?.getDrawStats?.().tilesVisible ?? 0
    }
    return v > 0
  }, null, { timeout: 60_000 })
  await page.waitForTimeout(5_000)

  // Capture per-VTR draw stats AFTER settle.
  const stats = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = (window as any).__xgisMap
    if (!map?.vtSources) return [] as VTRStats[]
    const out: VTRStats[] = []
    for (const [sourceName, entry] of map.vtSources.entries()) {
      const r = entry.renderer
      const ds = r.getDrawStats?.() ?? {}
      out.push({
        sourceName,
        tilesVisible: ds.tilesVisible ?? 0,
        drawCalls: ds.drawCalls ?? 0,
        missedTiles: ds.missedTiles ?? 0,
        triangles: ds.triangles ?? 0,
        lines: ds.lines ?? 0,
      })
    }
    return out
  })

  // Drive the camera with tiny invalidates so the render loop runs;
  // measure per-frame deltas over 3 s of steady-state holding.
  const frames = await page.evaluate(async (durationMs: number) => {
    const map = (window as unknown as { __xgisMap?: { invalidate: () => void } }).__xgisMap
    if (!map) throw new Error('no map')
    const out: number[] = []
    return await new Promise<number[]>((res) => {
      const t0 = performance.now()
      let last = t0
      const tick = () => {
        const now = performance.now()
        out.push(now - last)
        last = now
        if (now - t0 >= durationMs) { res(out); return }
        map.invalidate()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, 3000)

  const sorted = [...frames].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const worst = Math.max(...frames, 0)
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))] ?? 0

  const totalTilesVis = stats.reduce((a, b) => a + b.tilesVisible, 0)
  const totalDrawCalls = stats.reduce((a, b) => a + b.drawCalls, 0)
  const totalTriangles = stats.reduce((a, b) => a + b.triangles, 0)
  const totalLines = stats.reduce((a, b) => a + b.lines, 0)

  // eslint-disable-next-line no-console
  console.log(`\n=== osm_style high-pitch Manhattan ===`)
  console.log(`  steady-state hold (3 s):`)
  console.log(`    median frame:  ${median.toFixed(1)} ms (${(1000 / median).toFixed(0)} fps)`)
  console.log(`    p99 / worst:   ${p99.toFixed(1)} / ${worst.toFixed(0)} ms`)
  console.log(`  per-source:`)
  for (const s of stats) {
    console.log(`    ${s.sourceName}: tiles=${s.tilesVisible} draws=${s.drawCalls} tris=${s.triangles} lines=${s.lines}`)
  }
  console.log(`  total: tiles=${totalTilesVis} draws=${totalDrawCalls} tris=${totalTriangles} lines=${totalLines}`)

  const out = path.resolve('test-results', 'high-pitch-manhattan.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({
    hash: URL_HASH,
    perSource: stats,
    totals: { tiles: totalTilesVis, draws: totalDrawCalls, triangles: totalTriangles, lines: totalLines },
    frames: { count: frames.length, medianMs: median, p99Ms: p99, worstMs: worst },
  }, null, 2))
  // eslint-disable-next-line no-console
  console.log(`\n[saved] ${out}`)

  // Regression guards. Pre-fix on 2026-05-11 desktop measurement:
  //   tilesVis=170, drawCalls=205, tris=1.3M
  // After pitch-aware target SSE (this commit):
  //   tilesVis=62, drawCalls=74, tris=595k (~64 % reduction).
  // Thresholds at 100 / 130 / 800k catch any future regression that
  // re-introduces over-emission at high pitch — well below the
  // pre-fix numbers, well above the post-fix steady state.
  expect(totalTilesVis,
    `tilesVisible regressed: ${totalTilesVis} (pre-fix: 170, post-fix: 62). ` +
    `Pitch-aware targetSSE in tiles-sse.ts may have been bypassed.`,
  ).toBeLessThan(100)
  expect(totalDrawCalls,
    `drawCalls regressed: ${totalDrawCalls} (pre-fix: 205, post-fix: 74). ` +
    `Each extra draw on mobile costs ~200 µs of GPU pass time — keep this bounded.`,
  ).toBeLessThan(130)
  expect(totalTriangles,
    `triangle count regressed: ${totalTriangles} (pre-fix: 1.3M, post-fix: 595k).`,
  ).toBeLessThan(800_000)
})
