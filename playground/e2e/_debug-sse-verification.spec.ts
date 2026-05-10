// Multi-angle verification of the pitch-aware SSE + sub-pixel cull
// shipped in commit b939fc9. Diagnostic spec — runs the user's
// scenario plus boundary conditions and saves screenshots so we
// can eyeball the rendering for regressions.
//
// Categories:
//   1. Stability: re-runs the user URL on osm_style and reports
//      tilesVis / draws / tris / frame metrics for 3 iterations.
//   2. Pitch boundary: 50° (below ramp), 60° (boundary), 65° / 75°
//      (mid-ramp), 85° (max). Verifies the ramp behaves smoothly.
//   3. Other demos: filter_gdp + continent_match at typical
//      cameras so the change doesn't damage non-osm_style usage.
//   4. Visual screenshots: captured for each scenario, saved under
//      `__sse-verification__/` for human review.

import { test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__sse-verification__')
mkdirSync(OUT, { recursive: true })

interface Stats {
  tilesVis: number
  drawCalls: number
  triangles: number
  lines: number
  medianMs: number
  worstMs: number
}

async function measureScene(page: import('@playwright/test').Page, demoId: string, hash: string): Promise<Stats> {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/demo.html?id=${demoId}${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 60_000 },
  )
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
  await page.waitForTimeout(3500)

  const stats = await page.evaluate(async (durationMs: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = (window as any).__xgisMap
    let tilesVis = 0, drawCalls = 0, triangles = 0, lines = 0
    for (const entry of map.vtSources.values()) {
      const ds = entry.renderer.getDrawStats?.() ?? {}
      tilesVis += ds.tilesVisible ?? 0
      drawCalls += ds.drawCalls ?? 0
      triangles += ds.triangles ?? 0
      lines += ds.lines ?? 0
    }
    const frames: number[] = []
    await new Promise<void>((res) => {
      const t0 = performance.now()
      let last = t0
      const tick = () => {
        const now = performance.now()
        frames.push(now - last)
        last = now
        if (now - t0 >= durationMs) { res(); return }
        map.invalidate()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const sorted = [...frames].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0
    const worst = Math.max(...frames, 0)
    return { tilesVis, drawCalls, triangles, lines, medianMs: median, worstMs: worst }
  }, 2000)

  return stats
}

test('1. Stability — 3 runs of user URL', async ({ page }) => {
  test.setTimeout(180_000)
  const URL_HASH = '#16.18/40.76602/-73.97986/332.3/77.2'
  const runs: Stats[] = []
  for (let i = 0; i < 3; i++) {
    const s = await measureScene(page, 'osm_style', URL_HASH)
    runs.push(s)
    console.log(`  [run ${i + 1}] tiles=${s.tilesVis} draws=${s.drawCalls} tris=${s.triangles} median=${s.medianMs.toFixed(1)}ms worst=${s.worstMs.toFixed(0)}ms`)
    await page.goto('about:blank')
  }
  const tilesVar = Math.max(...runs.map(r => r.tilesVis)) - Math.min(...runs.map(r => r.tilesVis))
  console.log(`  [stability] tilesVis variance across 3 runs: ${tilesVar}`)
  writeFileSync(join(OUT, 'stability.json'), JSON.stringify(runs, null, 2))
})

test('2. Pitch boundary sweep — osm_style Manhattan z=16', async ({ page }) => {
  test.setTimeout(180_000)
  const pitches = [50, 60, 65, 75, 85]
  const results: Record<number, Stats> = {}
  for (const p of pitches) {
    const hash = `#16/40.76/-73.98/0/${p}`
    const s = await measureScene(page, 'osm_style', hash)
    results[p] = s
    console.log(`  [pitch=${p}°] tiles=${s.tilesVis} draws=${s.drawCalls} tris=${s.triangles} median=${s.medianMs.toFixed(1)}ms`)
    const png = await page.locator('#map').screenshot()
    writeFileSync(join(OUT, `pitch-${p}.png`), png)
    await page.goto('about:blank')
  }
  writeFileSync(join(OUT, 'pitch-sweep.json'), JSON.stringify(results, null, 2))
})

test('3. Other demos — filter_gdp + continent_match', async ({ page }) => {
  test.setTimeout(180_000)
  const cases = [
    { demo: 'filter_gdp', hash: '#3/30/0', label: 'filter_gdp z=3 global' },
    { demo: 'filter_gdp', hash: '#5/40/-100/0/60', label: 'filter_gdp z=5 pitch=60' },
    { demo: 'continent_match', hash: '#3/30/0', label: 'continent_match z=3 global' },
    { demo: 'osm_style', hash: '#10/40.7/-74/0/0', label: 'osm_style z=10 NYC flat' },
    { demo: 'osm_style', hash: '#14/35.68/139.76/0/0', label: 'osm_style z=14 Tokyo flat' },
  ]
  const results: Record<string, Stats> = {}
  for (const c of cases) {
    const s = await measureScene(page, c.demo, c.hash)
    results[c.label] = s
    console.log(`  [${c.label}] tiles=${s.tilesVis} draws=${s.drawCalls} tris=${s.triangles} median=${s.medianMs.toFixed(1)}ms`)
    const png = await page.locator('#map').screenshot()
    writeFileSync(join(OUT, `demo-${c.label.replace(/[^a-zA-Z0-9]/g, '_')}.png`), png)
    await page.goto('about:blank')
  }
  writeFileSync(join(OUT, 'other-demos.json'), JSON.stringify(results, null, 2))
})

test('4. User URL — visual capture', async ({ page }) => {
  test.setTimeout(60_000)
  const URL_HASH = '#16.18/40.76602/-73.97986/332.3/77.2'
  await measureScene(page, 'osm_style', URL_HASH)
  const png = await page.locator('#map').screenshot()
  writeFileSync(join(OUT, 'user-url-after-fix.png'), png)
})

test('5. Heavy-style stress — Bright (93 layers) at high pitch', async ({ page }) => {
  test.setTimeout(60_000)
  // openfreemap_bright fetches over the network on first load — give
  // it a longer settle. Use a Manhattan-like URL hash similar to the
  // user case so the layer count + camera both stress the renderer.
  const stats = await measureScene(page, 'openfreemap_bright', '#16/40.76/-73.98/0/77')
  console.log(`  [Bright pitch=77 z=16] tiles=${stats.tilesVis} draws=${stats.drawCalls} tris=${stats.triangles} median=${stats.medianMs.toFixed(1)}ms`)
  const png = await page.locator('#map').screenshot()
  writeFileSync(join(OUT, 'bright-high-pitch.png'), png)
})
