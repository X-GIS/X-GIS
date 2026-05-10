// Regression spec for the WebGPU-pipeline-prewarm cold-start fix.
//
// Background: WebGPU's `device.createRenderPipeline` returns a
// pipeline handle synchronously, but the GPU driver compiles the
// pipeline LAZILY on first draw. For variant-heavy demos
// (filter_gdp uses match() → custom shader variant pipelines), the
// first post-ready frame blocked >1 s on driver-internal compile.
// The CPU profile showed 60 %+ `(idle)` — JS thread waiting for
// the GPU command queue to drain that compile, not doing work itself.
//
// Fix (commit landing this spec): added
// `MapRenderer.prewarmShaderVariantsAsync` that walks the show
// commands, calls `createRenderPipelineAsync` for each variant's
// pipelines, and awaits Promise.all BEFORE __xgisReady flips. This
// hands the compile to the driver in parallel with init work; by
// the time the first frame fires, every pipeline is already ready.
//
// Asserts: post-ready worst frame < 300 ms across four cold-start
// configurations (GeoJSON + PMTiles, z=8 Europe + z=14 Tokyo).
// Threshold is generous — pre-fix runs landed at 700-1800 ms; the
// fix consistently puts every cell under 200 ms with headroom for
// variance.
//
// If this spec regresses, the next thing to look at is whether new
// shader variants were added without going through the prewarm path
// (e.g., a variant generated dynamically at first frame instead of
// at compile time).

import { test, expect } from '@playwright/test'

const cases: { demo: string; hash: string; label: string; budgetMs: number }[] = [
  // GeoJSON path. filter_gdp's match() variant was the original
  // 1.7 s offender. Budget tight enough to catch a regression.
  { demo: 'filter_gdp', hash: '#8/50/10', label: 'GeoJSON z=8 Europe', budgetMs: 300 },
  { demo: 'filter_gdp', hash: '#14/35.68/139.76', label: 'GeoJSON z=14 Tokyo', budgetMs: 500 },
  // PMTiles path also benefits — same variant pipelines, same
  // first-draw block. Wider budget because PMTiles cold-start
  // includes HTTP fetch which contributes a per-frame jitter.
  { demo: 'pmtiles_layered', hash: '#8/50/10', label: 'PMTiles z=8 Europe', budgetMs: 500 },
  { demo: 'pmtiles_layered', hash: '#14/35.68/139.76', label: 'PMTiles z=14 Tokyo', budgetMs: 500 },
]

for (const c of cases) {
  test(`cold-start worst frame < ${c.budgetMs} ms — ${c.label}`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/demo.html?id=${c.demo}${c.hash}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 60_000 },
    )
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
    const worst = Math.max(...frames, 0)
    const sorted = [...frames].sort((a, b) => a - b)
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))] ?? 0
    console.log(`[${c.label}] worst=${worst.toFixed(0)} ms p99=${p99.toFixed(1)} ms (${frames.length} frames over 3 s)`)
    expect(worst, `cold-start worst frame regressed past ${c.budgetMs} ms — pipeline prewarm may not be reaching this variant`).toBeLessThan(c.budgetMs)
  })
}
