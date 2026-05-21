// iter-287 — z=0 camera matrix probe.
//
// Auto-generated diagnostic for two open render-bug classes:
//   - project_mercator_z0_pitch_render: at z=0 + pitch=60 X-GIS
//     renders a flat horizontal strip vs MapLibre's proper
//     perspective wedge. Suspect: altitude / far / perspective
//     division degenerates at z=0 + wide cone.
//   - project_non_merc_z0_disc_render_fail: ortho / azi / stereo
//     at z=0 render essentially blank canvas (disc 5-6× too small).
//
// Both memos demand probe-first; this test dumps the resolved
// numbers Camera produces at the symptomatic cells + at the
// nearest known-good z=4 cell, side-by-side. Future post-fix
// runs diff against this baseline.
//
// Inline snapshot — eyeballable, vitest --update locks it.

import { describe, expect, it } from 'vitest'
import { Camera } from './camera'

const W = 800, H = 800, DPR = 1

/** Round numbers for stable snapshot — full precision belongs in
 *  the runtime, not the diagnostic. Altitude / far range over many
 *  orders of magnitude; 6 sig figs is enough to spot a degeneracy. */
function trunc(v: number, sig = 6): number {
  if (!Number.isFinite(v)) return v
  if (v === 0) return 0
  const k = Math.pow(10, sig - 1 - Math.floor(Math.log10(Math.abs(v))))
  return Math.round(v * k) / k
}

function snapKey(cam: Camera): Record<string, number> {
  const s = cam.getDebugSnapshot(W, H, DPR)
  // RTC matrix col 2 row 2 / row 3 = the perspective term that
  // produces foreshortening. row 3 col 2 = -1 (perspective).
  // m[10] = (far+near)/(near-far), m[14] = 2*far*near/(near-far).
  // If altitude → ∞ as zoom → 0, m[10] → -1, m[14] → -2·near,
  // and clip.w ≈ const across the world → no foreshortening.
  return {
    altitude: trunc(s.altitude),
    far: trunc(s.far),
    halfFovRad: trunc(s.halfFovRad),
    m10: trunc(s.matrix[10]!),
    m11: trunc(s.matrix[11]!),
    m14: trunc(s.matrix[14]!),
    // Perspective ratio: how strongly w varies across the visible
    // range. If a world point at z=0 produces clip.w == clip.w at
    // viewport edge, perspective is dead.
  }
}

describe('iter-287 z=0 camera matrix probe (mercator flat-strip + non-merc disc)', () => {
  it('records mercator z=0 pitch=60 vs z=4 pitch=60 vs z=0 pitch=0', () => {
    const z0p60 = new Camera(0, 0, 0)
    z0p60.pitch = 60
    const z4p60 = new Camera(0, 0, 4)
    z4p60.pitch = 60
    const z0p0 = new Camera(0, 0, 0)
    const dump = {
      'z=0 p=0':  snapKey(z0p0),
      'z=0 p=60': snapKey(z0p60),
      'z=4 p=60': snapKey(z4p60),
    }
    expect(dump).toMatchInlineSnapshot(`
      {
        "z=0 p=0": {
          "altitude": 93925800,
          "far": 148510000,
          "halfFovRad": 0.321751,
          "m10": -1.01273,
          "m11": -1,
          "m14": 93231000,
        },
        "z=0 p=60": {
          "altitude": 93925800,
          "far": 702756000,
          "halfFovRad": 0.321751,
          "m10": -0.501338,
          "m11": -0.5,
          "m14": 92296200,
        },
        "z=4 p=60": {
          "altitude": 5870360,
          "far": 43922200,
          "halfFovRad": 0.321751,
          "m10": -0.501338,
          "m11": -0.5,
          "m14": 5768510,
        },
      }
    `)
  })

  it('records derived ratios: at z=0 vs z=4 pitch=60, what scales?', () => {
    const z0 = new Camera(0, 0, 0)
    z0.pitch = 60
    const z4 = new Camera(0, 0, 4)
    z4.pitch = 60
    const s0 = z0.getDebugSnapshot(W, H, DPR)
    const s4 = z4.getDebugSnapshot(W, H, DPR)
    // Sanity: 4 zoom levels = 16× altitude reduction
    expect(s0.altitude / s4.altitude).toBeCloseTo(16, 0)
    // Far scales with altitude through maxViewAngle (pitch+halfFov)
    // — ratio should be the same 16× when pitch is fixed.
    expect(s0.far / s4.far).toBeCloseTo(16, 0)
    // halfFov is constant (Camera.FOV is module-level).
    expect(s0.halfFovRad).toBe(s4.halfFovRad)
  })

  it('records p=0 vs p=60 at z=0: only m10 / m11 / m14 / far change', () => {
    const flat = new Camera(0, 0, 0)
    const pitched = new Camera(0, 0, 0)
    pitched.pitch = 60
    const sf = flat.getDebugSnapshot(W, H, DPR)
    const sp = pitched.getDebugSnapshot(W, H, DPR)
    // Pitch doesn't move the camera position (translate term).
    expect(sf.altitude).toBe(sp.altitude)
    expect(sf.halfFovRad).toBe(sp.halfFovRad)
    // far DOES change because maxViewAngle = pitch + halfFov.
    expect(sp.far).toBeGreaterThan(sf.far)
  })
})
