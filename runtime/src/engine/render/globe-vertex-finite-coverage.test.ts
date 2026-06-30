// Workflow #2 — globe vertex output finiteness sweep.
//
// proj_globe(lon, lat) returns a 3D sphere position in vec3<f32>.
// If ANY input lon/lat produces NaN/Infinity in the output, the
// rasterizer behavior on the back hemisphere is undefined: some
// drivers cull NaN-clipped triangles, others rasterize them at
// arbitrary screen positions, leaking red pixels. The CPU mirror
// (`globeForward`) must be finite for every input the vertex shader
// can see — including extreme lats (±90), the antipode, and
// numerical-edge inputs.
//
// Pre-fix candidate symptoms this guards against:
//   - cos(±90°) ≈ 6e-17 (not exactly 0) — finite, but check
//   - sin(NaN) propagates — so input lon/lat NaN MUST be rejected
//     before reaching the vertex stage
//   - any IR pass that emits non-finite lon/lat (e.g. centroid
//     compute on a degenerate ring) would propagate.

import { describe, expect, it } from 'vitest'
import { globeForward } from '@xgis/engine'

describe('proj_globe vertex output finiteness (workflow #2)', () => {
  it('every (lon, lat) on a dense grid yields finite vec3', () => {
    for (let i = -180; i <= 180; i += 5) {
      for (let j = -90; j <= 90; j += 5) {
        const [x, y, z] = globeForward(i, j)
        expect(Number.isFinite(x), `proj_globe(${i}, ${j}).x not finite`).toBe(true)
        expect(Number.isFinite(y), `proj_globe(${i}, ${j}).y not finite`).toBe(true)
        expect(Number.isFinite(z), `proj_globe(${i}, ${j}).z not finite`).toBe(true)
      }
    }
  })

  it('poles produce finite (small-magnitude) output', () => {
    // sin(±90°·DEG2RAD) = ±1 exactly; cos(±90°·DEG2RAD) ≈ 6e-17
    // (not zero due to f64 trig). Sphere radius * 6e-17 ≈ 4e-10 — finite.
    for (const lat of [90, -90, 89.99999, -89.99999]) {
      for (const lon of [0, 90, -90, 180, -180]) {
        const [x, y, z] = globeForward(lon, lat)
        expect(Number.isFinite(x)).toBe(true)
        expect(Number.isFinite(y)).toBe(true)
        expect(Number.isFinite(z)).toBe(true)
        // z magnitude should approach ±EARTH_R at the poles.
        expect(Math.abs(z)).toBeGreaterThan(6.0e6) // > 6000 km
      }
    }
  })

  it('antipodal points produce finite output (sanity check)', () => {
    // Camera at (0,0), antipodes at (±180, 0).
    const a = globeForward(180, 0)
    const b = globeForward(-180, 0)
    for (const c of [a, b]) {
      for (const v of c) expect(Number.isFinite(v)).toBe(true)
    }
    // Antipode x-coordinate should be ≈ -EARTH_R relative to camera
    // origin (cos(180°) ≈ -1, sin(0) = 0 → y, z ≈ 0).
    expect(a[0]).toBeLessThan(-6e6)
    expect(b[0]).toBeLessThan(-6e6)
  })

  it('NaN/Infinity input propagates (caller must filter)', () => {
    // Intentional: WGSL fn proj_globe has no input gate. CPU mirror
    // matches — caller is responsible for filtering at the IR /
    // tile-build stage. This pins the contract so a future caller
    // change relying on internal sanitization fails this guard.
    const [x] = globeForward(NaN, 0)
    expect(Number.isNaN(x)).toBe(true)
  })
})
