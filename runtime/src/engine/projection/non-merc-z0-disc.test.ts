// Non-Mercator z=0 disc render scale.
//
// Memory project_non_merc_z0_disc_render_fail_2026_05_20:
// ortho / azi / stereo / oblique at z=0 + pitch=0 render essentially blank
// canvas (97% bg). The polygon VS now uses ECEF vertices + u.mvp from
// Camera.getECEFFrameView() — so the disc scale on screen is governed by
// the ratio (sphere radius EARTH_R) / (camera altitude in true ENU metres).
//
// At z=0 with an 800-px canvas the raw view-height is 62.6 Mm (one
// canvas-px = WORLD_MERC/TILE_PX = 78,271 m at z=0). The legacy
// _buildRTCMatrix clamps this at WORLD_MERC (40.075 Mm) — fine for the
// Mercator-plane vertex world that the legacy path frames. But the
// ECEF VS sees a SPHERE of radius EARTH_R (6.378 Mm), and the legacy
// 40-Mm clamp leaves altitude ≈ 60 Mm — so the projected sphere subtends
// only ~33 % of the canvas (R/alt × 1/tan(halfFov)).
//
// Fix: the WORLD_MERC clamp is a Mercator-world-height assumption; for
// the hemispherical non-cylindrical set (orthographic 3 / azimuthal_eq 4
// / stereographic 5 / globe 7) the visible-world height is the sphere
// diameter 2·EARTH_R = 12.756 Mm, not 40.075 Mm. The ECEF-MVP altitude
// cap should track that, so the disc fills the canvas at z=0 instead of
// occupying ~33 %.
//
// Test strategy: project (lon=±90, lat=0) — the eastern + western rim
// of the disc when centred at (lon=0, lat=0) — through the ECEF VS path
// and assert the screen-x delta covers ≥ half the canvas width.

import { describe, it, expect } from 'vitest'
import { Camera } from './camera'
import { mercatorToECEFSphere } from './ecef'

// Apply column-major 4x4 to a vec4 → vec4.
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

/** Project a (lon, lat) point through the ECEF VS path the production
 *  renderer uses: ecef_rtc = ecef(lon,lat) - cam.getECEFCenter(); clip =
 *  cam.getECEFFrameView().matrix * vec4(ecef_rtc, 1). Returns the screen-X
 *  in pixels (NDC.x → pixel) or null if behind the camera. */
function projectToScreenX(
  cam: Camera, lon: number, lat: number,
  canvasW: number, canvasH: number, dpr: number,
): number | null {
  const ecefVertex = mercatorToECEFSphere(
    // mercatorToECEFSphere takes (mx, my) but for the RIM points
    // (lon=±90 at lat=0) the Mercator forward is finite, so use the
    // engine's Mercator transform inline to keep the test honest about
    // what the renderer actually feeds the VS.
    lon * (Math.PI / 180) * 6378137,
    0,
    0,
  )
  const ecefCenter = cam.getECEFCenter()
  const ex = ecefVertex[0] - ecefCenter[0]
  const ey = ecefVertex[1] - ecefCenter[1]
  const ez = ecefVertex[2] - ecefCenter[2]
  const mvp = cam.getECEFFrameView(canvasW, canvasH, dpr).matrix
  const clip = mulMat4Vec4(mvp, [ex, ey, ez, 1])
  // Behind-camera reject (clip.w must be positive after perspective divide).
  if (clip[3] <= 1e-6) return null
  const ndcX = clip[0] / clip[3]
  // NDC → pixel
  return (ndcX + 1) * 0.5 * canvasW
}

const W = 800, H = 800, DPR = 1

describe('non-Merc z=0 disc render scale (orthographic / azimuthal_eq / stereographic / oblique_mercator / globe)', () => {
  // 3=ortho, 4=azimuthal_eq, 5=stereographic, 6=oblique_mercator, 7=globe.
  // At z=0 + pitch=0 + canvas 800×800 + lon=0,lat=0:
  //   sphere disc diameter = 2 · EARTH_R = 12.756 Mm
  // The ECEF camera should frame the disc to fill most of the canvas
  // (just like the Mercator plane fills the canvas in the cylindrical
  // projections at z=0). A disc that subtends only ~33% of the canvas
  // width is the visible-bug — fix should bring it to ≥ 50% so the disc
  // is plainly visible at z=0 p=0.
  for (const projType of [3, 4, 5, 6, 7]) {
    it(`projType=${projType}: disc spans ≥ half canvas at z=0 p=0`, () => {
      const cam = new Camera(0, 0, 0)
      cam.pitch = 0
      cam.bearing = 0
      cam.projType = projType
      // projType 7 (globe) flips globeMode on so the orbit camera is used;
      // projType 3..6 keep the 2D legacy path. This mirrors what
      // render-loop.ts does on each frame.
      cam.globeMode = (projType === 7)
      // projType 3..5 set globeOrtho=true in setProjection; mirror here
      // (this only matters if globeMode is also true).
      cam.globeOrtho = (projType >= 3 && projType <= 5)

      // Matrix must be finite (degenerate matrix would be the
      // "tiny sliver/blank" failure mode).
      const view = cam.getECEFFrameView(W, H, DPR)
      for (let i = 0; i < 16; i++) {
        expect(Number.isFinite(view.matrix[i]!), `matrix[${i}] non-finite for projType=${projType}`).toBe(true)
      }

      // Eastern + western rim of the disc when centred at (0, 0).
      // ECEF(lon=±90, lat=0) lies on the sphere equator 6.378 Mm east/west
      // of the projection centre.
      const east = projectToScreenX(cam, +89.9, 0, W, H, DPR)
      const west = projectToScreenX(cam, -89.9, 0, W, H, DPR)

      // Both rim points must project in-front-of-camera at z=0 + pitch=0.
      expect(east, `east-rim behind camera for projType=${projType}`).not.toBeNull()
      expect(west, `west-rim behind camera for projType=${projType}`).not.toBeNull()

      const span = Math.abs(east! - west!)
      // Disc must span ≥ 50 % of canvas width — pre-fix value is ~260 px
      // (32 %) for projType 3-6, exposing the WORLD_MERC mercator-world
      // clamp leaking into the sphere-projected views.
      expect(
        span,
        `disc span ${span.toFixed(1)}px on ${W}px canvas — too small (≈ ${(100 * span / W).toFixed(0)} % of canvas)`,
      ).toBeGreaterThanOrEqual(W * 0.5)
    })
  }
})
