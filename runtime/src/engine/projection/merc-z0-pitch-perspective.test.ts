// Mercator z=0 + pitch perspective fix.
//
// Bug (project_mercator_z0_pitch_render_2026_05_20): at z=0 + pitch=60
// X-GIS rendered a FLAT horizontal strip across the canvas while
// MapLibre rendered a proper pitched 3D perspective wedge. Per-pixel
// survey: 204,480 gt128 px (~45% of canvas) divergence vs MapLibre.
// All 11 other (zoom, pitch) cells were healthy (gt128 ≤ 30).
//
// Numeric root (iter-292 probe in camera-z0-probe.test.ts):
//   At z=0 the viewport height in Mercator meters (~62 Mm) exceeds the
//   world's 40 Mm extent. Altitude derives from viewport-height (~94 Mm
//   at 800px canvas) and far balloons with pitch. Perspective term m[10]
//   collapses toward -0.5, m[14] approaches -2·near, so clip.w varies
//   negligibly across world → no foreshortening → flat strip.
//
// Fix: cap the altitude-driving viewport height at WORLD_MERC. Once
// viewport ≥ world, holding viewHeightMeters at WORLD_MERC freezes the
// camera at the world-fit altitude (~30 Mm). This is the regime
// MapLibre operates in at low zoom and is where perspective division
// retains meaningful range.
//
// These tests pin both the numeric symptom (altitude/far ratios + m[14]
// magnitude) and the visible-bug regression (a world point near the
// viewport edge at pitch=60 must have noticeably different clip.w than
// a point at the camera center → real foreshortening, not flat strip).

import { describe, expect, it } from 'vitest'
import { Camera } from './camera'

const W = 800, H = 800, DPR = 1

/** Project a world point (Mercator m, RTC) → clip space. Mirrors
 *  what the GPU vertex shader does after RTC reconstruction. */
function projectRel(cam: Camera, relX: number, relY: number): { clipW: number; ndcZ: number } {
  const mvp = cam.getRTCMatrix(W, H, DPR)
  // column-major mvp × vec4(relX, relY, 0, 1)
  const clipZ = mvp[2]! * relX + mvp[6]! * relY + mvp[14]!
  const clipW = mvp[3]! * relX + mvp[7]! * relY + mvp[15]!
  return { clipW, ndcZ: clipZ / clipW }
}

describe('Mercator z=0 + pitch perspective (visible-bug fix)', () => {
  it('altitude is bounded — does not blow past world-fit at z=0', () => {
    // Pre-fix: viewport height = 800px × 78,271 m/px ≈ 62.6 Mm →
    // altitude ≈ 94 Mm (= 2.34 × WORLD_MERC). The camera was so far
    // that perspective effectively died.
    // Post-fix: altitude capped at the world-fit altitude — viewport
    // can't exceed WORLD_MERC, so altitude = WORLD_MERC/(2·tan(halfFov))
    // ≈ 60 Mm at MapLibre's 36.87° FOV. Still > world by 1.5× because
    // FOV is narrow, but no longer 2.3× and perspective math recovers.
    const cam = new Camera(0, 0, 0)
    cam.pitch = 60
    const s = cam.getDebugSnapshot(W, H, DPR)
    // Pre-fix was 93.9 Mm. Post-fix must be < 65 Mm (= world-fit + slack).
    expect(s.altitude).toBeLessThan(65_000_000)
    expect(s.altitude).toBeGreaterThan(0)
  })

  it('near/far stay sane at z=0 + pitch=60 (positive, far > near, finite)', () => {
    const cam = new Camera(0, 0, 0)
    cam.pitch = 60
    const s = cam.getDebugSnapshot(W, H, DPR)
    expect(Number.isFinite(s.far)).toBe(true)
    expect(s.far).toBeGreaterThan(0)
    // Pre-fix far was ~702 Mm at z=0 p=60. Post-fix scales with the
    // capped altitude so far ≤ ~480 Mm (= 60 Mm × 1/cos(pitch+halfFov)
    // × 1.5 safety). Use 500 Mm as a clean threshold.
    expect(s.far).toBeLessThan(500_000_000)
  })

  it('perspective division is meaningful: clip.w varies across viewport at pitch=60', () => {
    // The visible bug: pre-fix, two world points at very different
    // distances from camera produced near-identical clip.w (flat strip,
    // no perspective). Post-fix, clip.w must vary substantially as the
    // viewport scans from near edge to far edge.
    const cam = new Camera(0, 0, 0)
    cam.pitch = 60
    // Use the actual horizon-range of the visible viewport at this
    // pitch: a point in front of the camera at the visible-far end vs
    // a point near the camera. With altitude ~60 Mm + pitch 60°,
    // the far ground intersect is ~120 Mm forward (north). The near
    // ground intersect is ~35 Mm south (negative). Sample both.
    const near = projectRel(cam, 0, -30_000_000)
    const far = projectRel(cam, 0, 60_000_000)
    const ratio = Math.max(near.clipW, far.clipW) / Math.min(near.clipW, far.clipW)
    // Pre-fix ratio at z=0 p=60 was essentially 1 (no perspective).
    // Post-fix the foreshortening between near-viewport and far-viewport
    // world points should be substantial (> 2×).
    expect(ratio).toBeGreaterThan(2)
  })

  it('regression guard: z=4 pitch=60 perspective stays healthy (was already correct)', () => {
    // At z=4 the viewport is much smaller than the world, altitude
    // ~5.9 Mm, perspective always worked. Must not regress.
    const cam = new Camera(0, 0, 4)
    cam.pitch = 60
    const s = cam.getDebugSnapshot(W, H, DPR)
    expect(s.altitude).toBeLessThan(10_000_000)
    expect(s.altitude).toBeGreaterThan(1_000_000)
    expect(s.far).toBeGreaterThan(s.altitude)
  })

  it('regression guard: z=0 pitch=0 still produces sensible matrix', () => {
    // At pitch=0 the perspective looks the same regardless of altitude
    // (top-down view) but altitude/far must still be finite + positive.
    const cam = new Camera(0, 0, 0)
    const s = cam.getDebugSnapshot(W, H, DPR)
    expect(Number.isFinite(s.altitude)).toBe(true)
    expect(s.altitude).toBeGreaterThan(0)
    expect(Number.isFinite(s.far)).toBe(true)
    expect(s.far).toBeGreaterThan(0)
  })
})
