import { test, expect } from '@playwright/test'
import { captureCanvas, colorHistogram } from './helpers/visual'

// ═══ #797 Phase 1 — retained icon batch real-GPU N-independence gate ═══
//
// The MERGE-BLOCKING gate: 100k geo-anchored RETAINED icons under continuous
// pan/zoom must hold the per-frame icon-path CPU cost **N-INDEPENDENT** (same at
// 10k and 100k) and well within the 16.6 ms frame budget — whereas today's
// IconStage.setDraws repacks a vertexScratch of N quads EVERY frame
// (icon-renderer.ts:219), so its per-frame cost is O(N).
//
// The retained path projects on the GPU: a camera move rewrites only the ~160 B
// frame uniform (O(COPIES)), never the per-instance buffer. This spec drives the
// ACTUAL map on the real device and measures GraphicsManager.renderRetained's
// per-frame CPU time (the icon-path cost) plus two invariant counters:
//   (a) the retained pack is NOT re-run on a camera-only frame — the feat/tint
//       GPU-write counters stay UNCHANGED across the whole pan/zoom loop;
//   (b) an update({triggers:['color']}) re-uploads ONLY the tint buffer — it bumps
//       _tintWrites by exactly 1 and _featWrites by 0.
//
// Objective (timings + integer counters), so it needs no §5 visual read. HEADED
// by default (real Windows GPU; headless fails WebGPU adapter enumeration);
// `_`-prefixed → NOT in the CI SwiftShader render-gate list (local/pre-push gate,
// like _host-sprite-atlas-parity + _icon-rhi-parity).

interface Trial {
  n: number
  samples: number[]
  panWrites: {
    before: { featWrites: number; tintWrites: number }
    after: { featWrites: number; tintWrites: number }
  }
}
interface Result {
  trials: Trial[]
  tint: {
    before: { featWrites: number; tintWrites: number }
    after: { featWrites: number; tintWrites: number }
  }
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!
}

test.describe('#797 P1 retained icon batch — real-GPU N-independence', () => {
  test('100k retained icons: per-frame CPU N-independent + pack-once + tint-only', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 25_000 },
    )

    const result: Result | { error: string } = await page.evaluate(async () => {
      interface WriteCounts {
        featWrites: number
        tintWrites: number
      }
      interface Handle {
        update(p: { triggers: string[] }): void
        remove(): void
      }
      interface Graphics {
        add(spec: unknown): Handle
        setRenderTiming(on: boolean): void
        getRenderTimeSamples(): readonly number[]
        getWriteCounts(): WriteCounts
      }
      const map = (
        window as unknown as {
          __xgisMap?: {
            addImage(name: string, image: ImageData): void
            graphics: Graphics
            setZoom(z: number): void
            setCenter(lon: number, lat: number): void
            invalidate(): void
          }
        }
      ).__xgisMap
      if (!map) return { error: 'no __xgisMap' }

      // A tiny solid-blue 16×16 raster sprite.
      const px: number[] = []
      for (let i = 0; i < 16 * 16; i++) px.push(40, 120, 220, 255)
      map.addImage('pin', new ImageData(new Uint8ClampedArray(px), 16, 16))

      // Deterministic geo spread over the globe (no RNG — vary by index).
      const positions = (n: number): Array<{ lon: number; lat: number }> => {
        const out: Array<{ lon: number; lat: number }> = []
        for (let i = 0; i < n; i++) {
          out.push({ lon: ((i * 137.508) % 360) - 180, lat: ((i * 61.803) % 140) - 70 })
        }
        return out
      }

      const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

      // Drive continuous pan/zoom for `frames` rendered frames, collecting the
      // renderRetained per-frame CPU samples.
      const driveAndSample = async (frames: number): Promise<number[]> => {
        map.graphics.setRenderTiming(true) // resets the sample ring
        for (let t = 0; t < frames; t++) {
          map.setZoom(3 + 2 * Math.sin(t * 0.05))
          map.setCenter(((t * 1.7) % 360) - 180, ((t * 0.9) % 140) - 70)
          map.invalidate()
          await nextFrame()
        }
        await sleep(50)
        return [...map.graphics.getRenderTimeSamples()]
      }

      const trials: Trial[] = []
      for (const n of [10_000, 100_000]) {
        const data = positions(n)
        const handle = map.graphics.add({
          type: 'icon',
          data,
          getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
          getImage: 'pin',
          getSize: 1,
          getColor: (_d: unknown, i: number) => [((i * 7) % 255) / 255, 0.5, 0.8, 1],
          updateTriggers: { color: 1 },
        })
        // Let the initial upload + first frame settle before measuring.
        map.invalidate()
        await nextFrame()
        await sleep(100)
        const before = map.graphics.getWriteCounts()
        const samples = await driveAndSample(140)
        const after = map.graphics.getWriteCounts()
        trials.push({ n, samples, panWrites: { before, after } })
        handle.remove()
        await nextFrame()
      }

      // Tint-only re-upload: add a batch, snapshot counts, recolor, snapshot again.
      const tintData = positions(5_000)
      const tintHandle = map.graphics.add({
        type: 'icon',
        data: tintData,
        getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
        getImage: 'pin',
        getColor: () => [1, 0, 0, 1],
        updateTriggers: { color: 1 },
      })
      await nextFrame()
      const tintBefore = map.graphics.getWriteCounts()
      tintHandle.update({ triggers: ['color'] })
      const tintAfter = map.graphics.getWriteCounts()
      tintHandle.remove()

      return { trials, tint: { before: tintBefore, after: tintAfter } }
    })

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
    if ('error' in result) throw new Error(result.error)

    const t10 = result.trials.find((t) => t.n === 10_000)!
    const t100 = result.trials.find((t) => t.n === 100_000)!
    expect(t10.samples.length, '10k frames sampled').toBeGreaterThan(80)
    expect(t100.samples.length, '100k frames sampled').toBeGreaterThan(80)

    const p95_10 = p95(t10.samples)
    const p95_100 = p95(t100.samples)

    console.log(
      `[#797 P1] renderRetained p95: 10k=${p95_10.toFixed(3)}ms  100k=${p95_100.toFixed(3)}ms  ratio=${(p95_100 / Math.max(p95_10, 1e-4)).toFixed(2)}`,
    )

    // GATE 1 — within the 16.6 ms frame budget at 100k (p95, under motion).
    expect(p95_100, `100k renderRetained p95 = ${p95_100.toFixed(3)}ms`).toBeLessThanOrEqual(16.6)

    // GATE 2 — N-INDEPENDENT: the retained path does O(COPIES) work per frame, so
    // 100k costs ~the same as 10k. Allow generous slack (timer coarsening + GPU
    // submit noise) but reject any near-linear 10× scaling (which setDraws shows).
    // Absolute-tiny floor guards against dividing two sub-timer-resolution values.
    expect(
      p95_100,
      `N-DEPENDENT: 100k p95 ${p95_100.toFixed(3)}ms ≫ 10k p95 ${p95_10.toFixed(3)}ms`,
    ).toBeLessThanOrEqual(Math.max(p95_10 * 3 + 0.5, 2.0))

    // GATE 3 — pack NOT re-run on camera-only frames: the feat/tint GPU-write
    // counters are UNCHANGED across the entire pan/zoom loop, at BOTH counts.
    for (const t of result.trials) {
      expect(t.panWrites.after.featWrites, `${t.n}: featWrites during pan`).toBe(
        t.panWrites.before.featWrites,
      )
      expect(t.panWrites.after.tintWrites, `${t.n}: tintWrites during pan`).toBe(
        t.panWrites.before.tintWrites,
      )
    }

    // GATE 4 — update({color}) re-uploads ONLY the tint buffer.
    expect(result.tint.after.tintWrites - result.tint.before.tintWrites, 'tint recolor').toBe(1)
    expect(result.tint.after.featWrites - result.tint.before.featWrites, 'feat untouched').toBe(0)
  })

  // Correctness guard — the perf gate proves the retained path is FAST + flat, but
  // a path that draws NOTHING would also be fast + flat. This proves the retained
  // icons actually RASTERISE (distinctive magenta sprite appears on the canvas)
  // and that remove() clears them.
  test('retained icons rasterise on the real GPU (not just fast)', async ({ page }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 25_000 },
    )

    // Add a spread of big MAGENTA icons at a fixed low-zoom world view. Magenta
    // (230,30,230) is absent from any basemap, so the histogram is unambiguous.
    await page.evaluate(() => {
      const map = (
        window as unknown as {
          __xgisMap?: {
            addImage(name: string, image: ImageData): void
            graphics: { add(spec: unknown): { remove(): void } }
            setCenter(lon: number, lat: number): void
            setZoom(z: number): void
            invalidate(): void
          }
          __retainedBatch?: { remove(): void }
        }
      ).__xgisMap
      if (!map) return
      const px: number[] = []
      for (let i = 0; i < 48 * 48; i++) px.push(230, 30, 230, 255)
      map.addImage('mag', new ImageData(new Uint8ClampedArray(px), 48, 48))
      const data: Array<{ lon: number; lat: number }> = []
      for (let i = 0; i < 600; i++) {
        data.push({ lon: ((i * 137.508) % 340) - 170, lat: ((i * 53.7) % 120) - 60 })
      }
      const handle = map.graphics.add({
        type: 'icon',
        data,
        getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
        getImage: 'mag',
        getSize: 1,
      })
      ;(window as unknown as { __retainedBatch?: { remove(): void } }).__retainedBatch = handle
      map.setCenter(0, 20)
      map.setZoom(2)
      map.invalidate()
    })

    const magenta = [
      { name: 'mag', rgb: [230, 30, 230] as [number, number, number], tolerance: 50 },
    ]
    const withIcons = await captureCanvas(page)
    const h1 = await colorHistogram(page, withIcons, magenta)

    console.log(`[#797 P1] magenta icon coverage: ${(h1.mag * 100).toFixed(3)}%`)
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
    // The icons must actually paint — a non-trivial magenta coverage.
    expect(h1.mag, 'retained magenta icons must rasterise').toBeGreaterThan(0.002)

    // remove() clears them — magenta coverage collapses to ~nothing.
    await page.evaluate(() => {
      const w = window as unknown as {
        __retainedBatch?: { remove(): void }
        __xgisMap?: { invalidate(): void }
      }
      w.__retainedBatch?.remove()
      w.__xgisMap?.invalidate()
    })
    const without = await captureCanvas(page)
    const h2 = await colorHistogram(page, without, magenta)
    expect(h2.mag, 'remove() must clear the icons').toBeLessThan(Math.max(h1.mag * 0.1, 0.0005))
  })
})
