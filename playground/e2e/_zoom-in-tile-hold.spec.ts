// Regression spec for "previous tile is NOT held during continuous
// zoom-in over already-loaded vector tiles".
//
// User report (2026-05-10):
//   "타일이 로드되지 않은 상태에서 줌 인을 하면 이전 타일이
//    홀드되지 않고 즉시 빠져나가 타일이 비어있어 배경색이
//    보이게된다."
//
// The existing `_zoom-transition-blank-tiles.spec.ts` covers an
// INSTANT jump (camera.zoom = 16 in one tick) and asserts that the
// renderer's `_hysteresisZ` holds the old LOD. This spec covers the
// CONTINUOUS gesture (~60 fps × 5 s ramp) which exercises a
// different branch — hysteresis advances by 1 LOD as `camera.zoom`
// crosses each (cz + 0.6) threshold smoothly. If parent-fallback /
// LRU-protection / skeleton-keys aren't holding the previous LOD's
// GPU buffers across that boundary, the screen briefly shows the
// demo background color through the gaps.
//
// Two layers of detection:
//   A. Bookkeeping (cheap, every 6 frames during ramp):
//      `inspectPipeline().sources[].frame.tilesVisible` should never
//      drop below ~40 % of the settled baseline. A dip near zero
//      means the renderer has nothing to draw — hysteresis released
//      before fallback could populate.
//   B. Visual (5 spot screenshots at planned zoom values, second
//      pass): bg-color pixel fraction should not exceed baseline by
//      more than 35 %. Catches the case where bookkeeping reports
//      a tile is "visible" but its GPU buffer was actually evicted.
//
// Outputs:
//   playground/e2e/__zoom-in-tile-hold__/timeline.json
//   playground/e2e/__zoom-in-tile-hold__/baseline.png
//   playground/e2e/__zoom-in-tile-hold__/spot-z*.png

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__zoom-in-tile-hold__')
mkdirSync(OUT, { recursive: true })

interface SourceFrameStat {
  name: string
  tilesVisible: number
  missedTiles: number
  cacheSize: number
  pendingUploads: number
}

interface RampSample {
  /** Wall-clock ms relative to ramp start. */
  t: number
  cameraZoom: number
  /** Per-VTR `_hysteresisZ` — the integer LOD the renderer is committed to. */
  hysteresisZ: number[]
  /** Sum of tilesVisible across all VTRs (better signal than per-VTR
   *  for "is anything on screen"). */
  totalTilesVisible: number
  /** Per-source breakdown for diagnosis when the assert fails. */
  sources: SourceFrameStat[]
}

interface XgisMap {
  vtSources: Map<string, { renderer: { _hysteresisZ: number; getDrawStats?: () => { tilesVisible: number; missedTiles: number } } }>
  camera: { zoom: number }
  inspectPipeline?: () => {
    sources: Array<{
      name: string
      cache: { size: number; pendingLoads: number; pendingUploads: number }
      frame: { tilesVisible: number; missedTiles: number }
    }>
  }
}
declare global {
  interface Window { __xgisMap?: XgisMap; __xgisReady?: boolean }
}

const DEMO_URL = '/demo.html?id=pmtiles_layered#13/35.68/139.76'
const RAMP_DURATION_MS = 5000
const RAMP_SAMPLE_EVERY_FRAMES = 6
const SPOT_ZOOMS = [13.8, 14.2, 14.8, 15.5, 16.5]
const BG_TOLERANCE_PER_CHANNEL = 8 // 0..255

test.describe('Zoom-in tile hold (continuous gesture)', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('continuous z=13 → z=17 keeps coverage — no blank flash', async ({ page }) => {
    test.setTimeout(120_000)

    // Hook the runtime's `[FLICKER]` canary. The renderer emits this
    // warning whenever a visible tile has no GPU data AND no cached
    // ancestor — i.e., the exact "blank gap" the user reported. It's a
    // much cleaner signal than pixel sampling because the runtime
    // already reasons about "did fallback succeed?" per-tile per-frame.
    const flickerWarnings: Array<{ t: number; text: string; phase: 'pre-ramp' | 'ramp' | 'post' }> = []
    let phase: 'pre-ramp' | 'ramp' | 'post' = 'pre-ramp'
    const tStart = Date.now()
    page.on('console', (m) => {
      if (m.type() === 'warning' && m.text().includes('[FLICKER]')) {
        flickerWarnings.push({ t: Date.now() - tStart, text: m.text(), phase })
      }
    })

    // Bare ReferenceError or any uncaught exception during render is an
    // immediate fail — recently caught a missing-import regression in
    // vector-tile-renderer.ts where `visibleTilesFrustumSampled` was
    // used in the prefetch path but not imported, silently breaking
    // prefetch on every zoom-in.
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error' && /\[X-GIS frame\].*ReferenceError/.test(m.text())) {
        pageErrors.push(m.text())
      }
    })

    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => window.__xgisReady === true,
      null, { timeout: 30_000 },
    )
    // Settled state: every VTR has GPU-resident tiles AND nothing
    // pending. Settle on BOTH so cold-start dispatch race doesn't
    // leak into the baseline.
    await page.waitForFunction(() => {
      const map = window.__xgisMap
      if (!map?.vtSources) return false
      let visible = 0
      let pending = 0
      for (const { renderer } of map.vtSources.values()) {
        const ds = renderer.getDrawStats?.()
        visible += ds?.tilesVisible ?? 0
        const r = renderer as unknown as { getPendingUploadCount?: () => number }
        pending += r.getPendingUploadCount?.() ?? 0
      }
      return visible > 0 && pending === 0
    }, null, { timeout: 60_000 })
    await page.waitForTimeout(2000)

    // ── Baseline (settled, before any zoom) ──────────────────────────
    const baseline = await page.evaluate((tol) => {
      const map = window.__xgisMap!
      let totalVisible = 0
      const perSource: Array<{ name: string; tilesVisible: number }> = []
      for (const [name, { renderer }] of map.vtSources.entries()) {
        const ds = renderer.getDrawStats?.() ?? { tilesVisible: 0, missedTiles: 0 }
        totalVisible += ds.tilesVisible
        perSource.push({ name, tilesVisible: ds.tilesVisible })
      }

      // bg-fraction sample at settled state. Pull bg color from the
      // map's parsed style (Float32Array RGBA in 0..1) — cheap and
      // independent of any caller knowing the demo's bg hex.
      const bg = (map as unknown as { _backgroundColor?: Float32Array })._backgroundColor
      const bgRGB = bg
        ? [Math.round(bg[0] * 255), Math.round(bg[1] * 255), Math.round(bg[2] * 255)]
        : null

      return { totalVisible, perSource, bgRGB, tol }
    }, BG_TOLERANCE_PER_CHANNEL)

    if (!baseline.bgRGB) throw new Error('map._backgroundColor missing — demo has no background fill?')
    console.log(`[baseline] tilesVisible=${baseline.totalVisible} bg=rgb(${baseline.bgRGB.join(',')})`)

    // Capture baseline screenshot + bg fraction.
    const baselinePng = await page.locator('#map').screenshot()
    writeFileSync(join(OUT, 'baseline.png'), baselinePng)
    const baselineBgFraction = await measureBgFraction(page, baseline.bgRGB, BG_TOLERANCE_PER_CHANNEL)
    console.log(`[baseline] bgFraction=${(baselineBgFraction * 100).toFixed(1)}%`)

    const flickerBaseline = flickerWarnings.length
    console.log(`[baseline] flicker warnings during settle = ${flickerBaseline}`)

    // ── Pass 1: continuous ramp with bookkeeping samples ─────────────
    // The ramp is driven inside page.evaluate so each zoom delta is
    // pinned to a rAF tick (matches real wheel-event cadence). No
    // pixel reads happen during the ramp — those would distort timing.
    phase = 'ramp'
    const ramp = await page.evaluate(async (cfg) => {
      const map = window.__xgisMap!
      const samples: RampSample[] = []
      const t0 = performance.now()
      const tEnd = t0 + cfg.durationMs
      let frame = 0
      while (performance.now() < tEnd) {
        await new Promise<void>(r => requestAnimationFrame(() => r()))
        const elapsed = performance.now() - t0
        const t = Math.min(1, elapsed / cfg.durationMs)
        map.camera.zoom = cfg.startZoom + (cfg.endZoom - cfg.startZoom) * t
        frame++
        if (frame % cfg.sampleEvery === 0) {
          const hysteresisZ: number[] = []
          let totalVisible = 0
          for (const { renderer } of map.vtSources.values()) {
            hysteresisZ.push(renderer._hysteresisZ)
            totalVisible += renderer.getDrawStats?.().tilesVisible ?? 0
          }
          const inspect = map.inspectPipeline?.()
          const sources: SourceFrameStat[] = (inspect?.sources ?? []).map(s => ({
            name: s.name,
            tilesVisible: s.frame.tilesVisible,
            missedTiles: s.frame.missedTiles,
            cacheSize: s.cache.size,
            pendingUploads: s.cache.pendingUploads,
          }))
          samples.push({
            t: elapsed,
            cameraZoom: map.camera.zoom,
            hysteresisZ,
            totalTilesVisible: totalVisible,
            sources,
          })
        }
      }
      return samples
    }, { startZoom: 13, endZoom: 17, durationMs: RAMP_DURATION_MS, sampleEvery: RAMP_SAMPLE_EVERY_FRAMES })

    phase = 'post'
    const flickerDuringRamp = flickerWarnings.length - flickerBaseline
    console.log(`[ramp] flicker warnings emitted during ramp = ${flickerDuringRamp}`)

    // Save full timeline for diagnosis when an assertion fails.
    writeFileSync(join(OUT, 'timeline.json'),
      JSON.stringify({
        baseline: { ...baseline, bgFraction: baselineBgFraction, flickerCount: flickerBaseline },
        ramp,
        flickerWarnings,
      }, null, 2))

    // Trough metric — minimum of totalTilesVisible across the ramp.
    // A deep dip means the renderer briefly had nothing to draw.
    const trough = ramp.reduce(
      (acc, s) => s.totalTilesVisible < acc.totalTilesVisible ? s : acc,
      ramp[0] ?? { t: 0, cameraZoom: 0, hysteresisZ: [], totalTilesVisible: Infinity, sources: [] },
    )
    console.log(`[ramp] frames=${ramp.length}, trough at t=${trough.t.toFixed(0)}ms zoom=${trough.cameraZoom.toFixed(2)} totalTiles=${trough.totalTilesVisible} (baseline=${baseline.totalVisible})`)

    // ── Pass 2: spot screenshots at planned zoom values ──────────────
    // Each spot: jump to zoom, wait 200 ms (≈12 rAFs) for fallback /
    // upload to settle, take screenshot, sample bg fraction in Node.
    // 200 ms is intentionally short — long enough that the runtime's
    // hysteresis + fallback has a chance to compose, short enough
    // that a real bug (no hold, no fallback) still shows blank.
    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => window.__xgisReady === true,
      null, { timeout: 30_000 },
    )
    await page.waitForFunction(() => {
      const map = window.__xgisMap
      if (!map?.vtSources) return false
      let v = 0
      for (const { renderer } of map.vtSources.values()) {
        v += renderer.getDrawStats?.().tilesVisible ?? 0
      }
      return v > 0
    }, null, { timeout: 60_000 })
    await page.waitForTimeout(2000)

    const spotResults: Array<{ zoom: number; bgFraction: number }> = []
    for (const z of SPOT_ZOOMS) {
      await page.evaluate(async (target) => {
        window.__xgisMap!.camera.zoom = target
        // ~12 rAFs at 60 fps.
        for (let i = 0; i < 12; i++) {
          await new Promise<void>(r => requestAnimationFrame(() => r()))
        }
      }, z)
      const png = await page.locator('#map').screenshot()
      writeFileSync(join(OUT, `spot-z${z.toFixed(1)}.png`), png)
      const fr = await measureBgFraction(page, baseline.bgRGB, BG_TOLERANCE_PER_CHANNEL)
      spotResults.push({ zoom: z, bgFraction: fr })
      console.log(`[spot z=${z.toFixed(1)}] bgFraction=${(fr * 100).toFixed(1)}%`)
    }

    // ── Assertions ───────────────────────────────────────────────────
    // (0) No render-loop crashes. ReferenceError / unhandled exception
    //     during render means the previous frame's content is what the
    //     user sees regardless of any later assertion. Caught a
    //     `visibleTilesFrustumSampled is not defined` regression where
    //     the import statement dropped the function but the prefetch
    //     branch still called it — silently broke prefetch on every
    //     zoom-in.
    expect(pageErrors,
      `Render loop threw during the test: ${pageErrors.join('; ')}. ` +
      `Likely a missing import or null deref in the hot path.`,
    ).toEqual([])

    // (A) Runtime FLICKER canary: the renderer emits "[FLICKER] N tiles
    //     without fallback" whenever a visible tile has no GPU data AND
    //     no cached ancestor. Each warning = one frame where the user
    //     would see bg through a gap. A handful during cold-start is
    //     normal (tiles racing to land); a sustained stream during a
    //     warm-cache zoom-in is the user-reported regression.
    expect(flickerDuringRamp,
      `Excessive [FLICKER] warnings during continuous zoom: ${flickerDuringRamp} ` +
      `(baseline pre-ramp = ${flickerBaseline}). Each warning is a frame where the ` +
      `runtime's parent-walk fallback couldn't find any cached ancestor for a ` +
      `currently-visible tile — the user sees demo background through the gap. ` +
      `Diagnose by reading flickerWarnings[] in timeline.json and the spot-z*.png frames.`,
    ).toBeLessThan(15)

    // (B) Bookkeeping: the renderer should always have SOMETHING on
    //     screen during the ramp. Floor at 40% of baseline tile count
    //     — generous, catches only severe drops to ~0.
    expect(trough.totalTilesVisible,
      `tilesVisible dropped to ${trough.totalTilesVisible} at zoom=${trough.cameraZoom.toFixed(2)} ` +
      `(baseline ${baseline.totalVisible}, floor ${Math.floor(baseline.totalVisible * 0.4)}). ` +
      `Renderer briefly had nothing to draw — hysteresis released before fallback populated, ` +
      `or LRU evicted the parent before the child arrived.`,
    ).toBeGreaterThan(Math.floor(baseline.totalVisible * 0.4))

    // (C) Visual: spot screenshots should not show large bg-color
    //     patches beyond the baseline. Threshold = baseline + 15 pp.
    //     Tighter than (A) because (A) is the load-bearing assertion;
    //     (C) is the "even bookkeeping was wrong" backstop.
    const maxSpotBg = Math.max(...spotResults.map(s => s.bgFraction))
    expect(maxSpotBg,
      `Visual blank flash detected: max bg fraction during ramp = ${(maxSpotBg * 100).toFixed(1)}%, ` +
      `baseline = ${(baselineBgFraction * 100).toFixed(1)}%. ` +
      `Bookkeeping may report tilesVisible OK while the GPU buffers were evicted ` +
      `(catalog has slice metadata but layerCache miss).`,
    ).toBeLessThan(baselineBgFraction + 0.15)
  })
})

/** Sample the canvas via `toBlob` → ImageBitmap → OffscreenCanvas
 *  ImageData and count pixels within `tol` per channel of `bg`. Runs
 *  inside page.evaluate so the WebGPU canvas readback path is the same
 *  as production screenshot tooling. */
async function measureBgFraction(
  page: import('@playwright/test').Page,
  bg: [number, number, number] | number[],
  tol: number,
): Promise<number> {
  return await page.evaluate(async ({ bg, tol }) => {
    const canvas = document.getElementById('map') as HTMLCanvasElement
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/png'))
    if (!blob) return 0
    const bitmap = await createImageBitmap(blob)
    const off = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    let bgCount = 0
    const total = data.length / 4
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - bg[0]) <= tol &&
          Math.abs(data[i + 1] - bg[1]) <= tol &&
          Math.abs(data[i + 2] - bg[2]) <= tol) {
        bgCount++
      }
    }
    return bgCount / total
  }, { bg: [bg[0], bg[1], bg[2]], tol })
}
