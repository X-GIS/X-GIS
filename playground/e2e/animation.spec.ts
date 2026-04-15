import { test, expect, type ConsoleMessage } from '@playwright/test'
import {
  captureCanvas, hashScreenshot, colorHistogram,
  type ColorBucket,
} from './helpers/visual'

// ═══ X-GIS animation regression suite ═══
//
// Production-demo cycle continuity tests. Extracted from
// smoke.spec.ts so the animation timing is decoupled from the
// generic smoke / baseline pipeline.
//
// Each test loads an animation demo and samples the canvas at 6
// time points spanning >3 cycles, asserting:
//   1. Bug 1 cycle continuity (≥4 distinct hashes — proves the
//      animation is alive past the first iteration)
//   2. The expected keyframe colors actually appear at SOME
//      sample (proves the animation visits the right values,
//      not just "any non-base value")
//
// Coverage is "production demo at cycle granularity". For
// per-feature animation tests see fixtures.spec.ts /
// interactions.spec.ts.

test.describe('X-GIS animation regression', () => {
  test('animation_pulse: cycles past first iteration + amber stroke visible at peak', async ({ page }) => {
    test.setTimeout(30_000)
    const cycleMs = 1500
    await page.goto('/demo.html?id=animation_pulse', { waitUntil: 'domcontentloaded' })

    // 6 samples across ~3 cycles. Sample BOTH hash + amber ratio
    // at each point so we can prove (a) the cycle is alive (≥4
    // unique hashes) and (b) the amber stroke is actually being
    // rendered at SOME point during the cycle (max amber > 0.01).
    //
    // The range-based assertion is more robust than picking a
    // specific cycle phase — `_elapsedMs` doesn't reset on page
    // navigation and the init time is variable, so "sample at
    // peak" is unreliable. "Sample N times, assert max >
    // threshold" works regardless.
    //
    // amber-300 = #fcd34d ≈ RGB(252, 211, 77)
    const sampleTimes = [
      Math.round(cycleMs * 0.2),
      Math.round(cycleMs * 0.5),
      Math.round(cycleMs * 0.85),
      Math.round(cycleMs * 1.4),
      Math.round(cycleMs * 2.1),
      Math.round(cycleMs * 2.85),
    ]
    const hashes: string[] = []
    const amberPoints: number[] = []
    for (const t of sampleTimes) {
      const png = await captureCanvas(page, { elapsedMsAtLeast: t })
      hashes.push(await hashScreenshot(page, png))
      const r = await colorHistogram(page, png, [
        { name: 'amber', rgb: [252, 211, 77], tolerance: 100 },
      ])
      amberPoints.push(r.amber)
    }

    const unique = new Set(hashes).size
    expect(unique,
      `animation_pulse: only ${unique}/6 distinct frames — animation frozen`)
      .toBeGreaterThanOrEqual(4)

    // Amber must reach a non-trivial peak across the cycle —
    // catches "stroke vanished entirely" silent failures the
    // cycle hash test can't see.
    const maxAmber = Math.max(...amberPoints)
    expect(maxAmber,
      `animation_pulse: amber peak ${(maxAmber * 100).toFixed(2)}% across 6 samples ` +
      `(${amberPoints.map(r => (r * 100).toFixed(1) + '%').join(', ')}) — ` +
      `coastline stroke not reaching the canvas`)
      .toBeGreaterThan(0.01)
  })

  test('animation_showcase: cycles + rose ratio varies across cycle (proves heat keyframe morphs)', async ({ page }) => {
    test.setTimeout(40_000)
    const cycleMs = 2000
    await page.goto('/demo.html?id=animation_showcase', { waitUntil: 'domcontentloaded' })

    // 6-sample cycle continuity check (hash-based).
    const sampleTimes = [
      Math.round(cycleMs * 0.15),
      Math.round(cycleMs * 0.50),
      Math.round(cycleMs * 0.85),
      Math.round(cycleMs * 1.40),
      Math.round(cycleMs * 2.10),
      Math.round(cycleMs * 2.85),
    ]
    const hashes: string[] = []
    const rosePoints: number[] = []
    const buckets: ColorBucket[] = [
      { name: 'rose', rgb: [225, 29, 72], tolerance: 80 },
    ]
    for (const t of sampleTimes) {
      const png = await captureCanvas(page, { elapsedMsAtLeast: t })
      hashes.push(await hashScreenshot(page, png))
      const r = await colorHistogram(page, png, buckets)
      rosePoints.push(r.rose)
    }

    const unique = new Set(hashes).size
    expect(unique,
      `animation_showcase: only ${unique}/6 distinct frames — animation frozen`)
      .toBeGreaterThanOrEqual(4)

    // Bug 1 mirror via histogram: the rose ratio should swing
    // significantly across the 6 samples. If the heat keyframe
    // were frozen at any single value (slate OR rose), the range
    // would be near zero. Empirically: peak ~15%, trough ~0% →
    // range ≈ 15%. Assert range > 4% with plenty of headroom.
    const range = Math.max(...rosePoints) - Math.min(...rosePoints)
    expect(range,
      `animation_showcase: rose ratio range ${(range * 100).toFixed(1)}% across 6 samples ` +
      `(${rosePoints.map(r => (r * 100).toFixed(1) + '%').join(', ')}) — ` +
      `heat keyframe not morphing`)
      .toBeGreaterThan(0.04)

    // The rose ratio must also reach a non-trivial peak — proves
    // the rose-600 keyframe value is actually visited, not just
    // "anything changes" which a tiny pixel jitter could fake.
    expect(Math.max(...rosePoints),
      `animation_showcase: rose ratio peak ${(Math.max(...rosePoints) * 100).toFixed(1)}% — ` +
      `country fills never reached the rose-600 keyframe value`)
      .toBeGreaterThan(0.05)
  })
})
