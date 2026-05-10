import { describe, expect, it } from 'vitest'
import { computeLogDepthFc, simulateLogDepthZ } from '../engine/projection/wgsl-log-depth'

// ═══ Log-depth CPU sim tests ═══
//
// These mirror the exact WGSL formulas in wgsl-log-depth.ts so a regression
// in either side surfaces without needing a GPU. The core invariants:
//
//   1. fc = 1 / log2(far + 1)
//   2. Post-perspective-division NDC depth is monotonically increasing in
//      view-space distance (w).
//   3. Depth at w=near lies in [0, 1] and approaches 0; depth at w=far
//      approaches 1. (WebGPU depth range.)
//   4. Precision: at extreme near/far ratios (1 : 1e6) the near plane is
//      still resolvable above depth=0 — the whole point of log-depth.

describe('computeLogDepthFc', () => {
  it('matches 1 / log2(far + 1)', () => {
    expect(computeLogDepthFc(1)).toBeCloseTo(1 / Math.log2(2), 6)        // 1.0
    expect(computeLogDepthFc(1023)).toBeCloseTo(1 / Math.log2(1024), 6)  // 0.1
    expect(computeLogDepthFc(1e6)).toBeCloseTo(1 / Math.log2(1e6 + 1), 6)
  })

  it('is positive and finite for reasonable far planes', () => {
    for (const far of [1, 10, 1e3, 1e6, 1e9]) {
      const fc = computeLogDepthFc(far)
      expect(Number.isFinite(fc)).toBe(true)
      expect(fc).toBeGreaterThan(0)
    }
  })
})

describe('simulateLogDepthZ', () => {
  it('maps w=0 to ~0 and w=far to ~1 (WebGPU depth range)', () => {
    const far = 1000
    const zNear = simulateLogDepthZ(0.001, far)
    const zFar  = simulateLogDepthZ(far, far)
    expect(zNear).toBeGreaterThanOrEqual(0)
    expect(zNear).toBeLessThan(0.01) // very close to 0
    expect(zFar).toBeGreaterThan(0.99) // very close to 1
    expect(zFar).toBeLessThanOrEqual(1)
  })

  it('is strictly monotonically increasing in view-space w', () => {
    const far = 10000
    const samples = [0.001, 1, 10, 100, 1000, 5000, 9999]
    const depths = samples.map(w => simulateLogDepthZ(w, far))
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]).toBeGreaterThan(depths[i - 1])
    }
  })

  it('preserves near-plane resolvability at extreme near:far ratio', () => {
    // Standard 1/w depth collapses in the near region at ratios like 1:1e6.
    // Log depth should still resolve sub-meter detail near w=1.
    const far = 1e6
    const d1   = simulateLogDepthZ(1,    far)
    const d2   = simulateLogDepthZ(2,    far)
    const d10  = simulateLogDepthZ(10,   far)
    const d100 = simulateLogDepthZ(100,  far)
    // Each doubling of w should produce a distinct depth value well
    // above any realistic 24-bit depth ULP (~6e-8).
    expect(d2 - d1).toBeGreaterThan(1e-5)
    expect(d10 - d2).toBeGreaterThan(1e-5)
    expect(d100 - d10).toBeGreaterThan(1e-5)
  })

  it('log-depth precision at pitched map parameters (zoom 22 @ pitch 85)', () => {
    // Replicates camera.ts: altitude ~40m at zoom 22, far ~5700m at pitch 85
    const far = 5700
    // Near-plane depth at 1m should stay well above 0 — the whole point
    // of the refactor (classic 1/w depth puts this below 24-bit precision).
    const zAtOneMeter = simulateLogDepthZ(1, far)
    expect(zAtOneMeter).toBeGreaterThan(0.05)
    // Far-plane depth should approach 1.
    const zAtFar = simulateLogDepthZ(far, far)
    expect(zAtFar).toBeGreaterThan(0.99)
  })
})
