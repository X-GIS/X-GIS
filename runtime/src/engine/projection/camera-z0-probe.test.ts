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
import { Camera } from '@xgis/engine'

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
    // Post-fix baseline (project_mercator_z0_pitch_render fix). The
    // pre-fix z=0 numbers were:
    //   z=0 p=0  altitude=93925800 far=148510000 m14=93231000
    //   z=0 p=60 altitude=93925800 far=702756000 m14=92296200
    // The WORLD_MERC viewport-height cap in _buildRTCMatrix drops the
    // z=0 altitude from 94 Mm → 60 Mm and the z=0 p=60 far from 702 Mm
    // → 450 Mm, restoring real perspective foreshortening at z=0 with
    // pitch. z=4 p=60 row unchanged (cap inactive at z≥1 with 800px H).
    expect(dump).toMatchInlineSnapshot(`
      {
        "z=0 p=0": {
          "altitude": 60112500,
          "far": 95046200,
          "halfFovRad": 0.321751,
          "m10": -1.01273,
          "m11": -1,
          "m14": 59667800,
        },
        "z=0 p=60": {
          "altitude": 60112500,
          "far": 449764000,
          "halfFovRad": 0.321751,
          "m10": -0.501338,
          "m11": -0.5,
          "m14": 59069600,
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
    // Pre-fix: 4 zoom levels = 16× altitude reduction. Post-fix the
    // WORLD_MERC viewport cap activates at z=0 (canvas=800 wants 62.6
    // Mm viewport but world is 40 Mm), so z=0 altitude is the world-
    // fit floor instead of the raw zoom-derived value. Ratio is now
    // ~10.24× (60.1 Mm / 5.87 Mm) — the cap is doing its job.
    expect(s0.altitude / s4.altitude).toBeCloseTo(10.24, 1)
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

  // iter-292 — Pin the framing root cause. Self-diagnosis (iter-292
  // memory: ran _pixel-match-seoul-zoom-matrix, found z=0 p=0
  // gt128=122,688 px = 27 % canvas) confirmed the bug visually:
  // X-GIS renders world as 512×512 patch with black bars top/bottom;
  // MapLibre stretches world to fill canvas.
  //
  // Numeric root: at z=0 the viewport height in world meters far
  // exceeds Mercator world height. The camera sees "more sky than
  // world", and the pyramid pixel-perfect convention produces black
  // bars instead of stretching.
  it('z=0 framing: viewport-height-meters cap restores sane altitude', () => {
    // The RAW (uncapped) viewport-height at z=0 with 800 px canvas is
    // 62.6 Mm — greater than the world's 40 Mm extent. Pre-fix this
    // produced altitude ≈ 94 Mm and degenerate perspective at pitch.
    // Post-fix the camera caps the viewport-height at WORLD_MERC so
    // altitude saturates at ~60 Mm (world-fit altitude), restoring
    // foreshortening at z=0 + pitch.
    const cam = new Camera(0, 0, 0)
    const WORLD_MERC_LOCAL = 40075016.686
    const TILE_PX = 512
    const metersPerPixel = WORLD_MERC_LOCAL / TILE_PX  // z=0 baseline
    const rawViewportHeightMeters = H * metersPerPixel
    // Confirm the raw value (what the camera sees BEFORE the cap).
    expect(rawViewportHeightMeters).toBeGreaterThan(WORLD_MERC_LOCAL)
    expect(rawViewportHeightMeters / WORLD_MERC_LOCAL).toBeCloseTo(1.56, 1)
    // Post-fix altitude is bounded by the world-fit altitude (~60 Mm
    // at MapLibre's 36.87° FOV) — NOT the 94 Mm pre-fix value.
    const s = cam.getDebugSnapshot(W, H, DPR)
    expect(s.altitude).toBeLessThan(WORLD_MERC_LOCAL * 2)
  })

  // iter-292 — Same probe at z=4 confirms the bug is z=0-specific:
  // viewport much smaller than world at this zoom.
  it('at z>=4 the inverse holds: world far exceeds viewport — perspective healthy', () => {
    const cam = new Camera(0, 0, 4)
    const WORLD_MERC = 40075016.686
    const TILE_PX = 512
    const metersPerPixel = WORLD_MERC / TILE_PX / Math.pow(2, 4)
    const viewportHeightMeters = H * metersPerPixel
    // 800 * 4892 = 3.9 Mm viewport vs 40 Mm world → 1 % of world
    // visible. Normal "zoom in" regime.
    expect(viewportHeightMeters).toBeLessThan(WORLD_MERC / 10)
    const s = cam.getDebugSnapshot(W, H, DPR)
    // Altitude < world. Perspective division has meaningful range.
    expect(s.altitude).toBeLessThan(WORLD_MERC / 5)
  })
})
