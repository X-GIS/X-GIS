// Azimuthal disc pitch-framing continuity gate.
//
// The azimuthal family (orthographic 3 / azimuthal_equidistant 4 /
// stereographic 5) renders as a flat 2D disc at pitch=0 and PROMOTES to the
// globeOrtho (telephoto-parallel) orbit camera the instant the user tilts
// (render-loop promotesToGlobeWhenTilted). The user bug: the disc JUMPED scale
// at the pitch=0 boundary — ortho shrank ~2.5× the moment zoom crossed 1, and
// azi/stereo blew up ~3× at zoom<1 — because the globeOrtho altitude
// (globeAltitude) used a projType-BLIND `zoom<1 ? min(raw,2R) : raw` cap while
// the flat disc (flatViewHeightCapM) used a per-projType cap (2·EARTH_R for
// ortho, WORLD_MERC for azi/stereo) at ALL zooms.
//
// The fix drives the globeOrtho altitude from the SAME flatViewHeightCapM the
// flat disc uses (threaded through camera.azimuthalProjType → buildGlobeMatrix
// → globeAltitude's ortho branch). This gate pins the continuity: the
// globeOrtho disc edge at pitch=0+ must land at the SAME screen position as the
// flat disc edge at pitch=0, within a small tolerance (the ORTHO_TELE=96
// telephoto leaves a sub-percent residual, NOT byte-equality), across the
// {3,4,5} × zoom grid where the old caps disagreed.

import { describe, it, expect } from 'vitest'
import { Camera } from '@xgis/map'
import { buildGlobeMatrix, globeForward, globeAltitude } from '@xgis/geo'
import { WORLD_MERC, TILE_PX } from '@xgis/geo'
import { flatViewHeightCapM } from '@xgis/geo'
import { projectGeomCpu, projectCpu } from '@xgis/map'

const W = 800,
  H = 800,
  DPR = 1
const FOV_RAD = 0.6435011087932844 // == Camera.FOV

/** The flat-disc camera altitude for a projType at a zoom: the EXACT value
 *  `_buildRTCMatrix` produces for the flat 2D disc at pitch=0, using the
 *  per-projType flat view-height cap. This is the scale the globeOrtho path
 *  must match across the pitch=0 boundary. */
function flatDiscAltitude(zoom: number, projType: number): number {
  const mpp = WORLD_MERC / TILE_PX / Math.pow(2, zoom)
  const raw = H * mpp
  const vh = Math.min(raw, flatViewHeightCapM(projType, WORLD_MERC))
  return vh / 2 / Math.tan(FOV_RAD / 2)
}

function mulMat4Vec4(
  m: Float32Array | ArrayLike<number>,
  v: [number, number, number, number],
): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0]
  for (let r = 0; r < 4; r++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += m[k * 4 + r] * v[k]
    out[r] = s
  }
  return out
}

/** Screen-X (px) of (lon, 0) through the FAITHFUL flat path: the flat_rel CPU
 *  mirror fed into the production flat MVP, camera centred at (0, 0). */
function flatScreenX(cam: Camera, projType: number, lon: number): number | null {
  const [vx, vy] = projectGeomCpu(projType, lon, 0, 0, 0, 0)
  const [cx, cy] = projectCpu(projType, 0, 0, 0, 0)
  const mvp = cam.getViewForProjection(projType, W, H, DPR).matrix
  const clip = mulMat4Vec4(mvp, [vx - cx, vy - cy, 0, 1])
  if (clip[3] <= 1e-6) return null
  return (clip[0] / clip[3] + 1) * 0.5 * W
}

/** Screen-X (px) of (lon, 0) through the globeOrtho RTC matrix at a given
 *  pitch — the camera-relative sphere vertex (globeForward(lon,0) − focus)
 *  fed into buildGlobeMatrix(ortho=true), camera centred at (0, 0). */
function globeOrthoScreenX(
  zoom: number,
  projType: number,
  pitch: number,
  lon: number,
): number | null {
  const v = buildGlobeMatrix(0, 0, zoom, pitch, 0, W, H, true, projType)
  const fc = globeForward(0, 0)
  const g = globeForward(lon, 0)
  const rel: [number, number, number, number] = [g[0] - fc[0], g[1] - fc[1], g[2] - fc[2], 1]
  const clip = mulMat4Vec4(v.rtcMatrix, rel)
  if (clip[3] <= 1e-6) return null
  return (clip[0] / clip[3] + 1) * 0.5 * W
}

// Each azimuthal projType's flat disc EDGE longitude — the rim the flat MVP
// frames to the canvas. ortho clamps its limb at lon±90 (rho=EARTH_R); azi/
// stereo extend further but ±89.9 is a stable, well-inside-the-limb sample
// whose screen position is governed entirely by the view-height cap (scale).
const EDGE_LON = 89.9

describe('azimuthal disc pitch-framing continuity (globeOrtho altitude == flat-disc altitude)', () => {
  // ROOT INVARIANT: the disc on-screen SCALE is set by the camera altitude.
  // The globeOrtho (azimuthal-promoted) altitude MUST equal the flat 2D disc
  // altitude at every zoom, or the disc jumps size at the pitch=0 boundary.
  // The grid below is exactly where the OLD projType-blind cap disagreed:
  //   ortho (3) at z≥1 — old globe went uncapped → 2.45× alt → disc 2.5× too
  //     small (user screenshot 08: ortho z1 pitch55 small + lower-left).
  //   azi (4) / stereo (5) at z<1 — old globe capped 2R → 0.32× alt → disc ~3×
  //     too big, near-full-canvas (user screenshot 10: azi z0.5 pitch30).
  // (NOTE: this is geometry-FREE — it pins the altitude the fix changed, not a
  // rim position. The flat azimuthal forwards (ortho/azi/stereo) are DIFFERENT
  // 2D projections of the rim, but the globeOrtho disc is always an
  // orthographic sphere silhouette; only the cap-driven altitude differs, and
  // that altitude is the scale that was jumping.)
  for (const projType of [3, 4, 5]) {
    for (const zoom of [0, 0.5, 1, 1.5, 2]) {
      it(`projType=${projType} z${zoom}: globeOrtho altitude == flat-disc altitude`, () => {
        const flatAlt = flatDiscAltitude(zoom, projType)
        const globeOrthoAlt = globeAltitude(zoom, H, true, projType)
        const ratio = globeOrthoAlt / flatAlt
        // Exact equality (same cap, same formula) — allow only float noise.
        expect(
          ratio,
          `projType=${projType} z${zoom}: globeOrtho alt ${(globeOrthoAlt / 1e6).toFixed(3)}Mm vs flat ${(flatAlt / 1e6).toFixed(3)}Mm (ratio ${ratio.toFixed(4)}) — pitch=0 scale discontinuity`,
        ).toBeCloseTo(1, 6)
      })
    }
  }

  // Pre-fix REGRESSION pin: the OLD projType-blind globeAltitude (ortho=false
  // branch) is the broken path — assert it genuinely disagrees with the flat
  // disc on the offending cells, so this gate would have CAUGHT the bug.
  it('the old projType-blind altitude DID jump (regression witness)', () => {
    // ortho z1: the projType-blind path is uncapped at z≥1 (#450 left z≥1
    // untouched) → ~2.45× the flat 2R-capped alt: a hard jump.
    const oldOrthoZ1 = globeAltitude(1, H, false) / flatDiscAltitude(1, 3)
    expect(oldOrthoZ1).toBeGreaterThan(2) // would have been a hard jump
    // azi z0: the OLD projType-blind `min(raw, 2R)` cap was ~0.32× the flat
    // WORLD_MERC-capped azi alt. #450 removed that z<1 cap from the perspective
    // globe (globeAltitude ortho=false), so compute the historical capped value
    // inline rather than via the now-uncapped production path.
    const mppZ0 = WORLD_MERC / TILE_PX / Math.pow(2, 0)
    const oldCappedAltZ0 = Math.min(H * mppZ0, 2 * 6378137) / 2 / Math.tan(FOV_RAD / 2)
    const oldAziZ0 = oldCappedAltZ0 / flatDiscAltitude(0, 4)
    expect(oldAziZ0).toBeLessThan(0.4)
  })

  // ORTHO-ONLY end-to-end span check: for orthographic (3) the flat 2D forward
  // IS the orthographic projection of the sphere, so the flat-disc rim and the
  // globeOrtho disc rim genuinely coincide (within the ORTHO_TELE telephoto
  // residual ~0.35%). This exercises the FULL matrix (not just globeAltitude),
  // confirming the matrix scale follows the altitude across the boundary.
  for (const zoom of [0, 0.5, 1, 1.5]) {
    it(`projType=3 (ortho) z${zoom}: globeOrtho disc edge at pitch=0+ ≈ flat disc edge at pitch=0`, () => {
      const cam = new Camera(0, 0, zoom)
      cam.pitch = 0
      cam.projType = 3
      cam.globeMode = false
      cam.globeOrtho = true
      const flatEast = flatScreenX(cam, 3, +EDGE_LON)
      const flatWest = flatScreenX(cam, 3, -EDGE_LON)
      expect(flatEast, 'flat east null').not.toBeNull()
      expect(flatWest, 'flat west null').not.toBeNull()
      const flatSpan = Math.abs(flatEast! - flatWest!)

      const gEast = globeOrthoScreenX(zoom, 3, 0.001, +EDGE_LON)
      const gWest = globeOrthoScreenX(zoom, 3, 0.001, -EDGE_LON)
      expect(gEast, 'globeOrtho east null').not.toBeNull()
      expect(gWest, 'globeOrtho west null').not.toBeNull()
      const gSpan = Math.abs(gEast! - gWest!)

      const ratio = gSpan / flatSpan
      expect(
        ratio,
        `ortho z${zoom}: globeOrtho span ${gSpan.toFixed(1)}px vs flat ${flatSpan.toFixed(1)}px (ratio ${ratio.toFixed(3)}) — pitch=0 scale discontinuity`,
      ).toBeGreaterThan(0.97)
      expect(ratio).toBeLessThan(1.03)
    })
  }

  // Foreshortening smoothness: increasing pitch must SHRINK the vertical extent
  // of the disc monotonically (a true 3D tilt), with NO scale jump from the
  // flat→globeOrtho boundary. Measure the north pole-ward edge screen-Y.
  it('projType=3: pitch increases foreshorten the disc smoothly (no boundary jump)', () => {
    const screenY = (pitch: number): number => {
      const v = buildGlobeMatrix(0, 0, 1, pitch, 0, W, H, true, 3)
      const fc = globeForward(0, 0)
      const g = globeForward(0, 60) // a northward point on the disc
      const rel: [number, number, number, number] = [g[0] - fc[0], g[1] - fc[1], g[2] - fc[2], 1]
      const clip = mulMat4Vec4(v.rtcMatrix, rel)
      return (1 - clip[1] / clip[3]) * 0.5 * H
    }
    // As pitch grows the northward point moves toward the horizon (smaller
    // vertical screen offset from centre). Monotonic, continuous.
    const y0 = screenY(0.001)
    const y20 = screenY(20)
    const y45 = screenY(45)
    // y increases downward; the northward point starts ABOVE centre (y<400).
    // Foreshortening pulls it DOWN toward centre as pitch grows.
    expect(y20).toBeGreaterThan(y0)
    expect(y45).toBeGreaterThan(y20)
    // Continuity at the boundary: the pitch=0.001 frame is within a hair of
    // the pitch=0 frame (no scale step).
    const yEps = screenY(0)
    expect(Math.abs(yEps - y0)).toBeLessThan(1) // < 1px between pitch 0 and 0.001
  })

  // Centre invariance: the disc centre (focus) maps to screen centre at every
  // pitch (RTC subtracts the focus → clip (0,0)). The user-reported "pushed to
  // lower-left corner" was the SCALE step, not a centre offset; pin that the
  // centre never moves.
  it('disc centre maps to screen centre at every pitch (no centre drift)', () => {
    for (const projType of [3, 4, 5]) {
      for (const pitch of [0, 30, 55]) {
        const v = buildGlobeMatrix(0, 0, 1, pitch, 0, W, H, true, projType)
        const clip = mulMat4Vec4(v.rtcMatrix, [0, 0, 0, 1]) // focus = RTC origin
        const sx = (clip[0] / clip[3] + 1) * 0.5 * W
        const sy = (1 - clip[1] / clip[3]) * 0.5 * H
        expect(
          Math.abs(sx - W / 2),
          `projType=${projType} pitch=${pitch} centreX drift`,
        ).toBeLessThan(1)
        expect(
          Math.abs(sy - H / 2),
          `projType=${projType} pitch=${pitch} centreY drift`,
        ).toBeLessThan(1)
      }
    }
  })

  // True-globe guard: the perspective globe (projType 7, ortho=false) altitude
  // must be UNCHANGED by the fix — its globeAltitude takes the untouched
  // zoom<1-gated sphere branch. Pin a representative cell.
  it('true globe (ortho=false) framing is untouched by the azimuthal fix', () => {
    // ortho=false ignores the projType arg entirely — assert byte-identical
    // matrices with and without an azimuthal projType passed.
    const a = buildGlobeMatrix(10, 20, 1.5, 30, 0, W, H, false, 7)
    const b = buildGlobeMatrix(10, 20, 1.5, 30, 0, W, H, false, 3)
    for (let i = 0; i < 16; i++) {
      expect(a.rtcMatrix[i]).toBe(b.rtcMatrix[i])
    }
    expect(a.far).toBe(b.far)
  })
})
