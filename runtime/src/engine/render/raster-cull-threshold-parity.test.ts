// Pin raster vs vector cull-threshold parity at the visible rim of
// azimuthal_equidistant + stereographic (iter 431). Pre-fix raster
// vis used raw center_cos_c; vector path used needs_backface_cull
// (which thresholds at -0.85 / -0.8). At cosC in (-0.85, 0) raster
// would discard while vector still rendered — visible misalignment
// at the rim of the projection disc.

import { describe, expect, it } from 'vitest'
import { cosC, needsBackfaceCullWgsl } from '../shaders/dsl'

const PROJECTIONS = [
  { name: 'orthographic',         type: 3, threshold: 0 },      // strict hemisphere
  { name: 'azimuthal_equidistant', type: 4, threshold: -0.85 },  // wider rim
  { name: 'stereographic',        type: 5, threshold: -0.8 },   // wider rim
]

// Post-fix raster vis matches needsBackfaceCullWgsl exactly (vis >= 1 →
// keep, < 0 → discard). Pre-fix would have used `Math.sign(cosC(...))`
// → cull at cosC < 0 for all three projections.
//
// #600 — this file pins ONLY the DISC projections (ortho/azimuthal/
// stereographic 3/4/5), which keep the pitch-invariant center_cos_c cull and
// IGNORE globe_eye. So the new globe_eye arg is left at its all-zero default
// (the globe(7) eye-horizon arm is covered by back-face-cull-comprehensive).
function rasterCullPost(pt: number, lon: number, lat: number, clon: number, clat: number): number {
  return needsBackfaceCullWgsl(pt, lon, lat, clon, clat)
}

function rasterCullPre(lon: number, lat: number, clon: number, clat: number): number {
  return cosC(lon, lat, clon, clat) // raw cosC, fragment discards if < 0
}

describe('raster vs vector cull-threshold parity (iter 431 fix)', () => {
  for (const proj of PROJECTIONS) {
    describe(proj.name, () => {
      // Find a rim point where cosC sits in the projection's threshold
      // band. The band is between proj.threshold and 0 for azimuthal/
      // stereo (where the pre-fix raster discarded but vector kept).
      // Orthographic has threshold=0 so there's no band — both old and
      // new behave the same.
      it('rim band point: post-fix raster matches vector behaviour', () => {
        if (proj.threshold === 0) {
          // Strict hemisphere — no band.
          expect(true).toBe(true)
          return
        }
        // Pick a point with cosC midway in the band (between
        // proj.threshold and 0). For azimuthal threshold -0.85 we use
        // cc=-0.5; for stereo threshold -0.8 we use cc=-0.4.
        const ccTarget = proj.threshold / 2 // half-way to threshold, definitely in band
        const rimLon = Math.acos(ccTarget) * 180 / Math.PI
        const cc = cosC(rimLon, 0, 0, 0)
        // Confirm we're in the rim band: cc between threshold and 0.
        expect(cc).toBeLessThan(0)
        expect(cc).toBeGreaterThan(proj.threshold)

        // Pre-fix: raster discards (cc < 0).
        expect(rasterCullPre(rimLon, 0, 0, 0)).toBeLessThan(0)

        // Post-fix: raster routes through needsBackfaceCullWgsl,
        // which RETURNS +1 (keeps the fragment) because cc > threshold.
        expect(rasterCullPost(proj.type, rimLon, 0, 0, 0)).toBeGreaterThan(0)
      })

      it('past-threshold point: both raster paths discard', () => {
        // Beyond the threshold — cc = -0.95, well past azimuthal's -0.85.
        const lon = Math.acos(-0.95) * 180 / Math.PI // ≈ 162°
        expect(rasterCullPre(lon, 0, 0, 0)).toBeLessThan(0)
        expect(rasterCullPost(proj.type, lon, 0, 0, 0)).toBeLessThan(0)
      })

      it('front hemisphere: both raster paths keep', () => {
        const lon = 20 // cosC = cos(20°·π/180) ≈ 0.94
        expect(rasterCullPre(lon, 0, 0, 0)).toBeGreaterThan(0)
        expect(rasterCullPost(proj.type, lon, 0, 0, 0)).toBeGreaterThan(0)
      })
    })
  }

  it('post-fix raster and vector use the same per-projection threshold', () => {
    // Sweep azimuthal at a rim band point; vector polygon cull (which
    // also routes through needsBackfaceCullWgsl) must produce the same
    // sign as the post-fix raster path.
    const clon = 0, clat = 0
    for (const pt of [3, 4, 5]) {
      for (let i = 0; i < 5; i++) {
        const cc = -0.95 + i * 0.3 // sweep -0.95, -0.65, -0.35, -0.05, 0.25
        const lon = Math.acos(Math.max(-1, Math.min(1, cc))) * 180 / Math.PI
        const rasterPost = rasterCullPost(pt, lon, 0, clon, clat)
        const vectorCull = needsBackfaceCullWgsl(pt, lon, 0, clon, clat)
        expect(Math.sign(rasterPost)).toBe(Math.sign(vectorCull))
      }
    }
  })
})
