// Realistic mobile pinch-gesture stress: simulates actual user
// behaviour rather than the synthetic single-axis ramps the prior
// continuous-wheel specs used. User feedback (Seoul z=10 URL):
// instant `camera.zoom = X` and linear ramps don't reproduce real
// mobile pinch — actual gestures change zoom + center + pitch
// simultaneously, with ease-in-out curves (acceleration on press,
// deceleration on release), and arrive in short bursts separated
// by sub-second idle windows.
//
// This spec drives 4 bursts per direction, each 1 s of multi-axis
// motion (ease-in-out cubic), separated by 200 ms idle windows
// (just past the prefetch / fetch idle gate threshold). Each burst
// changes zoom and center together, alternating with pitch sweeps,
// then reverses. Peaks are measured per-frame so any spike is
// caught.
//
// Fail conditions: tilesVisible peak > 200 (mobile budget), heap
// delta > 600 MB. The pre-fix-series baseline at this scenario
// peaked far above either.

import { test, expect } from '@playwright/test'

interface XgisCamera {
  zoom: number
  centerX: number
  centerY: number
  pitch?: number
  bearing?: number
}
interface XgisMap {
  vtSources: Map<string, { renderer: { getDrawStats?: () => { tilesVisible: number; drawCalls: number } } }>
  camera: XgisCamera
}
declare global {
  interface Window { __xgisMap?: XgisMap; __xgisReady?: boolean }
}

test.describe('Realistic mobile pinch gesture', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('4 bursts × multi-axis ease-in-out at Seoul z=13: bounded peaks', async ({ page }) => {
    test.setTimeout(180_000)

    await page.goto(
      `/demo.html?id=pmtiles_layered#13/37.6172/127.0801`,
      { waitUntil: 'domcontentloaded' },
    )
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
    await page.waitForTimeout(3000)

    // One burst: ease-in-out cubic interpolation of zoom + center
    // + (optionally) pitch over `durationMs`. Records peaks each rAF.
    const burst = async (
      from: { zoom: number; cx: number; cy: number; pitch: number },
      to: { zoom: number; cx: number; cy: number; pitch: number },
      durationMs: number,
    ): Promise<{ tilesVisible: number; drawCalls: number; heapMB: number | null }> => {
      return await page.evaluate(async ({ from, to, durationMs }) => {
        const map = window.__xgisMap!
        const ease = (t: number) => t < 0.5
          ? 4 * t * t * t
          : 1 - Math.pow(-2 * t + 2, 3) / 2
        const peaks = { tilesVisible: 0, drawCalls: 0, heapMB: null as number | null }
        const t0 = performance.now()
        while (performance.now() - t0 < durationMs) {
          await new Promise<void>(r => requestAnimationFrame(() => r()))
          const raw = Math.min(1, (performance.now() - t0) / durationMs)
          const t = ease(raw)
          map.camera.zoom = from.zoom + (to.zoom - from.zoom) * t
          map.camera.centerX = from.cx + (to.cx - from.cx) * t
          map.camera.centerY = from.cy + (to.cy - from.cy) * t
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ('pitch' in map.camera) (map.camera as any).pitch = from.pitch + (to.pitch - from.pitch) * t
          for (const { renderer } of map.vtSources.values()) {
            const ds = renderer.getDrawStats?.() ?? { tilesVisible: 0, drawCalls: 0 }
            if (ds.tilesVisible > peaks.tilesVisible) peaks.tilesVisible = ds.tilesVisible
            if (ds.drawCalls > peaks.drawCalls) peaks.drawCalls = ds.drawCalls
          }
          const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          if (heap) {
            const mb = Math.round(heap.usedJSHeapSize / 1048576)
            if (peaks.heapMB === null || mb > peaks.heapMB) peaks.heapMB = mb
          }
        }
        return peaks
      }, { from, to, durationMs })
    }

    // Read starting camera as f64 mercator so we can offset relative
    // to it without introducing latitude conversion errors.
    const start = await page.evaluate(() => {
      const c = window.__xgisMap!.camera
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cur = c as any
      return { zoom: c.zoom, cx: c.centerX, cy: c.centerY, pitch: cur.pitch ?? 0 }
    })

    // ~10 km eastward at the starting latitude. centerX is in
    // mercator meters; one degree of longitude ≈ 111 km × cos(lat),
    // but at z=13 we just want to shift the visible window enough
    // to evict + re-fetch the next column of tiles, so a fixed
    // 10 km step is sufficient.
    const STEP_M = 10_000

    // 4 bursts at REALISTIC pinch rates. Real users zoom 1-2 LODs
    // in ~0.3-0.5 s (≈ 2-4 zoom/s), pan ~10 km in 0.5 s. Earlier
    // 1 s/burst undersold the actual rate by ~3×, so the spec
    // wasn't catching the load profile that drove the user heat
    // report. 400 ms/burst with 100 ms idle ≈ a sustained pinch
    // gesture from a real user.
    const bursts = [
      { dz: +1.5, dcx: +STEP_M, dcy: 0,         dpitch: 0,   label: 'zoom-in + pan-east' },
      { dz: +1,   dcx: 0,        dcy: 0,         dpitch: +30, label: 'zoom-in + tilt-up' },
      { dz: -2,   dcx: -STEP_M,  dcy: 0,         dpitch: 0,   label: 'zoom-out + pan-west' },
      { dz: -0.5, dcx: 0,        dcy: -STEP_M,   dpitch: -20, label: 'zoom-out + pan-south + tilt-down' },
    ]

    const overallPeaks = { tilesVisible: 0, drawCalls: 0, heapMB: 0 }
    let cur = { ...start }
    for (const b of bursts) {
      const next = {
        zoom: cur.zoom + b.dz,
        cx: cur.cx + b.dcx,
        cy: cur.cy + b.dcy,
        pitch: Math.max(0, Math.min(85, cur.pitch + b.dpitch)),
      }
      const peaks = await burst(cur, next, 400)
      console.log(`[${b.label}] tilesVisible peak ${peaks.tilesVisible}, drawCalls ${peaks.drawCalls}, heap ${peaks.heapMB} MB`)
      if (peaks.tilesVisible > overallPeaks.tilesVisible) overallPeaks.tilesVisible = peaks.tilesVisible
      if (peaks.drawCalls > overallPeaks.drawCalls) overallPeaks.drawCalls = peaks.drawCalls
      if ((peaks.heapMB ?? 0) > overallPeaks.heapMB) overallPeaks.heapMB = peaks.heapMB ?? 0
      cur = next
      await page.waitForTimeout(100)
    }

    console.log(`[overall] tilesVisible ${overallPeaks.tilesVisible}, drawCalls ${overallPeaks.drawCalls}, heap ${overallPeaks.heapMB} MB`)

    expect(overallPeaks.tilesVisible).toBeLessThan(200)
    expect(overallPeaks.drawCalls).toBeLessThan(1500)
    expect(overallPeaks.heapMB).toBeLessThan(800)
  })

  test('10 s sustained pan + zoom (no idle gaps) at z=10: bounded peaks', async ({ page }) => {
    test.setTimeout(180_000)

    // User-reported URL hash: #9.99/37.6172/127.0801. Region zoom
    // (z=10) covers a wider tile set than city zoom — exactly the
    // case that drove the user's "엄청 느려지고 발열" report on a
    // real iPhone. Test reproduces the conditions, not just z=13.
    await page.goto(
      `/demo.html?id=pmtiles_layered#9.99/37.6172/127.0801/0.3/2.3`,
      { waitUntil: 'domcontentloaded' },
    )
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
    await page.waitForTimeout(3000)

    // 10 s sustained — no idle gaps anywhere. Worst case for the
    // gesture-suppression fix: cameraIdle stays false for 10 s, so
    // visible-tile fetches stay suppressed the entire time. Parent
    // walk has to carry the rendering. If something starves under
    // sustained motion (parent eviction, cancelStale unbounded
    // abort spam, etc.) it surfaces here, not in the burst test.
    const result = await page.evaluate(async () => {
      const map = window.__xgisMap!
      const start = {
        zoom: map.camera.zoom,
        cx: map.camera.centerX,
        cy: map.camera.centerY,
      }
      // Sin-driven motion at REALISTIC rates: zoom oscillates ±2 LODs
      // through 4 cycles in 10 s (peak rate ~5 zoom/s, mid-pinch),
      // center pans 15 km in ~1.7 s (~9 km/s, fast drag). No idle
      // gaps — the camera is always moving, the worst case for the
      // gesture-suppression fix.
      const peaks = { tilesVisible: 0, drawCalls: 0, heapMB: null as number | null }
      const frameTimes: number[] = []
      const t0 = performance.now()
      const DURATION = 10_000
      let lastFrame = t0
      while (performance.now() - t0 < DURATION) {
        await new Promise<void>(r => requestAnimationFrame(() => r()))
        const now = performance.now()
        frameTimes.push(now - lastFrame)
        lastFrame = now
        const t = (now - t0) / DURATION
        const phase = t * Math.PI * 4 // 4 cycles in 10 s
        map.camera.zoom = start.zoom + 2 * Math.sin(phase)
        map.camera.centerX = start.cx + 15_000 * Math.sin(phase * 1.3)
        map.camera.centerY = start.cy + 8_000 * Math.cos(phase * 1.3)
        for (const { renderer } of map.vtSources.values()) {
          const ds = renderer.getDrawStats?.() ?? { tilesVisible: 0, drawCalls: 0 }
          if (ds.tilesVisible > peaks.tilesVisible) peaks.tilesVisible = ds.tilesVisible
          if (ds.drawCalls > peaks.drawCalls) peaks.drawCalls = ds.drawCalls
        }
        const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        if (heap) {
          const mb = Math.round(heap.usedJSHeapSize / 1048576)
          if (peaks.heapMB === null || mb > peaks.heapMB) peaks.heapMB = mb
        }
      }
      // Drop the first frame (cold-start can be misleading).
      const ft = frameTimes.slice(1)
      const avgMs = ft.reduce((a, b) => a + b, 0) / ft.length
      const sorted = [...ft].sort((a, b) => a - b)
      const p95Ms = sorted[Math.floor(sorted.length * 0.95)]
      const slow = ft.filter(f => f > 33).length
      return { peaks, avgMs, p95Ms, slowFrames: slow, totalFrames: ft.length }
    })
    console.log(`[10 s sustained @ z=10] tilesVisible peak ${result.peaks.tilesVisible}, drawCalls ${result.peaks.drawCalls}, heap ${result.peaks.heapMB} MB`)
    console.log(`  frame time: avg ${result.avgMs.toFixed(1)} ms, p95 ${result.p95Ms.toFixed(1)} ms, >33 ms: ${result.slowFrames}/${result.totalFrames} (${(100 * result.slowFrames / result.totalFrames).toFixed(0)}%)`)

    expect(result.peaks.tilesVisible).toBeLessThan(200)
    expect(result.peaks.drawCalls).toBeLessThan(1500)
    if (result.peaks.heapMB !== null) expect(result.peaks.heapMB).toBeLessThan(800)
    // p95 frame time under 50 ms (20 fps minimum) — anything past
    // this on a desktop Chromium signals real-device thermal risk.
    expect(result.p95Ms).toBeLessThan(50)
  })
})
