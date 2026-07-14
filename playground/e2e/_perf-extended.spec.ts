// Phase 0 perf baseline: 9-cell zoom × pitch matrix on Seoul Liberty
// with CPU steady-state frame timing + GPU pass breakdown + heap delta.
// Output: REPORT.md table + per-cell JSON for regression comparison
// across iter 134 → Phase 1+.

import { test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__perf-extended__')
mkdirSync(OUT, { recursive: true })

interface Cell {
  slug: string
  zoom: number
  pitch: number
}

const CELLS: Cell[] = [
  { slug: 'z14-p0', zoom: 14, pitch: 0 },
  { slug: 'z14-p30', zoom: 14, pitch: 30 },
  { slug: 'z14-p60', zoom: 14, pitch: 60 },
  { slug: 'z16-p0', zoom: 16, pitch: 0 },
  { slug: 'z16-p30', zoom: 16, pitch: 30 },
  { slug: 'z16-p60', zoom: 16, pitch: 60 },
  { slug: 'z18-p0', zoom: 18, pitch: 0 },
  { slug: 'z18-p30', zoom: 18, pitch: 30 },
  { slug: 'z18-p60', zoom: 18, pitch: 60 },
]

interface CellResult {
  slug: string
  loadMs: number
  steadyP50: number
  steadyP95: number
  steadyMax: number
  drawCalls: number
  vertices: number
  triangles: number
  tilesVisible: number
  gpuBreakdownMs: Record<string, number> // segment → p50 ms
  heapBeforeMb: number
  heapAfterMb: number
  heapDeltaMb: number
}

const results: CellResult[] = []

for (const cell of CELLS) {
  test(`perf-ext ${cell.slug}`, async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1280, height: 800 })

    const hash = `#${cell.zoom}/37.5172/126.9810/0/${cell.pitch}`
    const t0 = Date.now()
    // gpuprof=1 enables WebGPU timestamp-query path.
    await page.goto(`/compare.html?style=openfreemap-liberty&gpuprof=1${hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __xgisReady?: boolean }
        return w.__xgisReady === true
      },
      null,
      { timeout: 60_000 },
    )
    const loadMs = Date.now() - t0
    await page.waitForTimeout(4_000)

    // Heap snapshot pre-steady-state
    const heapBefore = await page.evaluate(async () => {
      const w = window as unknown as {
        performance: { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> }
      }
      try {
        if (w.performance.measureUserAgentSpecificMemory) {
          const m = await w.performance.measureUserAgentSpecificMemory()
          return m.bytes / 1024 / 1024
        }
      } catch {
        /* unavailable in headless */
      }
      // Fallback: deprecated performance.memory (chromium-only)
      const pm = (window.performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      return pm ? pm.usedJSHeapSize / 1024 / 1024 : 0
    })

    // 4-second CPU frame-time capture.
    const steady = await page.evaluate(async () => {
      const samples: number[] = []
      let last = performance.now()
      let runs = 0
      await new Promise<void>((resolve) => {
        const tick = (now: number) => {
          const dt = now - last
          last = now
          if (runs > 0) samples.push(dt)
          runs++
          if (runs > 240) return resolve()
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      samples.sort((a, b) => a - b)
      return {
        p50: samples[Math.floor(samples.length * 0.5)]!,
        p95: samples[Math.floor(samples.length * 0.95)]!,
        max: samples[samples.length - 1]!,
      }
    })

    // GPU pass breakdown (median ms per segment from ring buffer).
    const gpuBreakdown = await page.evaluate(() => {
      const m = (
        window as unknown as {
          __xgisMap?: { gpuTimer?: { getBreakdown: () => Record<string, number[]> } }
        }
      ).__xgisMap
      const breakdown = m?.gpuTimer?.getBreakdown() ?? {}
      const out: Record<string, number> = {}
      for (const [name, samples] of Object.entries(breakdown)) {
        if (samples.length === 0) continue
        const sorted = samples.slice().sort((a, b) => a - b)
        out[name] = sorted[Math.floor(sorted.length * 0.5)]! / 1e6 // ns → ms
      }
      return out
    })

    const drawStats = await page.evaluate(() => {
      const m = (
        window as unknown as {
          __xgisMap?: {
            vtSources?: Map<
              string,
              {
                renderer?: {
                  getDrawStats?: () => {
                    drawCalls: number
                    vertices: number
                    triangles: number
                    tilesVisible: number
                  }
                }
              }
            >
          }
        }
      ).__xgisMap
      if (!m?.vtSources) return null
      const agg = { drawCalls: 0, vertices: 0, triangles: 0, tilesVisible: 0 }
      for (const [, src] of m.vtSources) {
        const s = src.renderer?.getDrawStats?.()
        if (!s) continue
        agg.drawCalls += s.drawCalls
        agg.vertices += s.vertices
        agg.triangles += s.triangles
        agg.tilesVisible += s.tilesVisible
      }
      return agg
    })

    // Heap snapshot post-steady-state.
    const heapAfter = await page.evaluate(async () => {
      const w = window as unknown as {
        performance: { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> }
      }
      try {
        if (w.performance.measureUserAgentSpecificMemory) {
          const m = await w.performance.measureUserAgentSpecificMemory()
          return m.bytes / 1024 / 1024
        }
      } catch {
        /* unavailable */
      }
      const pm = (window.performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      return pm ? pm.usedJSHeapSize / 1024 / 1024 : 0
    })

    const r: CellResult = {
      slug: cell.slug,
      loadMs,
      steadyP50: +steady.p50.toFixed(2),
      steadyP95: +steady.p95.toFixed(2),
      steadyMax: +steady.max.toFixed(2),
      drawCalls: drawStats?.drawCalls ?? 0,
      vertices: drawStats?.vertices ?? 0,
      triangles: drawStats?.triangles ?? 0,
      tilesVisible: drawStats?.tilesVisible ?? 0,
      gpuBreakdownMs: gpuBreakdown,
      heapBeforeMb: +heapBefore.toFixed(1),
      heapAfterMb: +heapAfter.toFixed(1),
      heapDeltaMb: +(heapAfter - heapBefore).toFixed(2),
    }
    results.push(r)
    writeFileSync(join(OUT, `${cell.slug}.json`), JSON.stringify(r, null, 2))

    console.log(
      `[perf-ext ${cell.slug}] load=${r.loadMs}ms p50=${r.steadyP50}ms p95=${r.steadyP95}ms ` +
        `tris=${r.triangles} tiles=${r.tilesVisible} heapΔ=${r.heapDeltaMb}MB`,
    )
  })
}

test.afterAll(() => {
  if (results.length === 0) return
  const lines: string[] = []
  lines.push('# Phase 0 perf baseline — Seoul Liberty 9-cell matrix')
  lines.push('')
  lines.push('OFM Liberty at Seoul 37.5172/126.9810. Each cell: 4 s steady-state')
  lines.push('frame capture after 4 s settle. GPU breakdown median ms per segment')
  lines.push('via timestamp-query (?gpuprof=1).')
  lines.push('')
  lines.push('| Cell | Load(ms) | p50(ms) | p95(ms) | max(ms) | Draws | Tris | Tiles | HeapΔ(MB) |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const r of results) {
    lines.push(
      `| ${r.slug} | ${r.loadMs} | ${r.steadyP50} | ${r.steadyP95} | ${r.steadyMax} | ${r.drawCalls} | ${r.triangles} | ${r.tilesVisible} | ${r.heapDeltaMb} |`,
    )
  }
  lines.push('')
  lines.push('## GPU pass breakdown (median ms)')
  lines.push('')
  // Discover all segment names across cells.
  const allSegments = new Set<string>()
  for (const r of results) for (const k of Object.keys(r.gpuBreakdownMs)) allSegments.add(k)
  const segs = [...allSegments]
  lines.push(`| Cell | ${segs.join(' | ')} |`)
  lines.push(`|---|${segs.map(() => '---:').join('|')}|`)
  for (const r of results) {
    const row = segs.map((s) => r.gpuBreakdownMs[s]?.toFixed(2) ?? '—')
    lines.push(`| ${r.slug} | ${row.join(' | ')} |`)
  }
  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n'))

  console.log(`[perf-ext] report → ${join(OUT, 'REPORT.md')}`)
})
