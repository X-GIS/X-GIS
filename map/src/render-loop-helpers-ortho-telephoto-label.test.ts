// #1051 — ortho-telephoto globe sub-mode: label projection under the ×96
// telephoto matrix.
//
// The azimuthal disc set (orthographic 3 / azimuthal_equidistant 4 /
// stereographic 5) renders as an EXACT flat 2D disc at pitch 0, but the runtime
// PROMOTES it to the 3D globe vertex path the instant it tilts:
//   • viewport-mode-controller.ts:146-157 sets camera.globeOrtho = true for the
//     azimuthal set (globeMode stays false until pitch>0);
//   • render-loop.ts:139-152, per frame, sees promotesToGlobeWhenTilted(projType)
//     && pitch>0, stores the source disc in camera.azimuthalProjType, flips
//     projType to 7, and sets camera.globeMode = true.
// The resulting orbit camera is a TELEPHOTO (near-parallel) one: buildGlobeMatrix
// pushes the eye back by ORTHO_TELE = 96× the altitude and narrows the FOV by the
// same factor (geo/src/globe.ts:211-213), with the near/far bracket clamped
// TIGHTLY to the shell (±1.5R around the eye, globe.ts:266-267) instead of the
// perspective globe's |eye|-scaled far. That distinct matrix had ZERO
// label-projection coverage — the anchor projector, horizon cull, and
// screen-space limb silhouette (makeLabelProjectors' `!flat` branch) were only
// ever exercised on the PERSPECTIVE globe (globeOrtho=false).
//
// Every case derives the camera through the SAME public path the renderer uses —
// the field promotion above + getViewForProjection(7,…) — never a hand-rolled
// matrix, and asserts: (i) it really is the ×96 telephoto regime; (ii) the
// view-centre anchor lands dead-centre; (iii) no kept near-limb label floats past
// the projected globe silhouette. Pure CPU, like the sibling
// render-loop-helpers-globe-label*.test.ts.
import { describe, it, expect } from 'vitest'
import { Camera } from './camera'
import { makeLabelProjectors, LABEL_LIMB_INSET_PX } from './render-loop-helpers'
import { EARTH_R } from '@xgis/geo'

const W = 800,
  H = 600
// Centre-anchor tolerance (DEVICE px). The centre anchor is the sub-eye surface
// point; the RTC label matrix places the orbit camera's lookAt TARGET at NDC 0,
// so it lands dead-centre at ANY pitch. The only displacement is the
// ellipsoid-anchor vs sphere-focus geodetic residual — the anchor is
// lonLatToECEF on the WGS84 ellipsoid while the focus/target ride the sphere
// (radius A) — a fixed metre offset that projects to ≤ ~0.8 px here and scales
// with DPR (device-pixel doubling). 2 px covers that + float32-MVP rounding.
const CENTRE_TOL_PX = 2
type V3 = readonly [number, number, number]

/** Build the ortho-telephoto globe camera the runtime way: an azimuthal disc
 *  (projType 3/4/5) tilted past pitch 0 → globeMode + globeOrtho + projType 7,
 *  with the source disc kept in azimuthalProjType (its flat view-height-cap
 *  authority). Then take the SAME getViewForProjection(7,…) the render loop
 *  takes — the label projector reads exactly the matrix/eye the renderer feeds
 *  the vertex shaders. */
function orthoTelephoto(
  azi: number,
  lon: number,
  lat: number,
  zoom: number,
  pitch: number,
  dpr: number,
) {
  const cam = new Camera(lon, lat, zoom)
  cam.azimuthalProjType = azi // source disc (3 ortho / 4 azimuthal_eq / 5 stereo)
  cam.projType = 7 // promoted to the globe vertex path
  cam.globeMode = true
  cam.globeOrtho = true // → telephoto (near-parallel) orbit camera
  cam.pitch = pitch // > 0 is the promotion trigger
  const dw = Math.round(W * dpr)
  const dh = Math.round(H * dpr)
  const view = cam.getViewForProjection(7, dw, dh, dpr)
  const eye = view.eye as V3
  const focus = cam.getECEFCenter()
  return {
    eye,
    D: Math.hypot(eye[0], eye[1], eye[2]),
    far: view.far,
    exact: makeLabelProjectors(view.matrix, dw, dh, undefined, eye, focus, false),
    margin: makeLabelProjectors(view.matrix, dw, dh, undefined, eye, focus, true),
    dw,
    dh,
  }
}

/** Sweep the tilt meridian (lon = centre lon; bearing 0 tilts the camera along
 *  it, so this line runs through the visible cap from the centre out to the
 *  limb) and, under the LABEL-pass projector, report: how many anchors it KEEPS,
 *  the smallest silhouette inset among those kept (the anchor nearest the limb —
 *  the "near-limb" probe), and whether the label gate CULLED any front-hemi
 *  in-bounds anchor (proving the horizon/limb gate is live, not a no-op). A 0.2°
 *  step lands a sample within ~1 px of the limb at these disc sizes. */
function meridianLimbSweep(
  margin: ReturnType<typeof makeLabelProjectors>,
  exact: ReturnType<typeof makeLabelProjectors>,
  lon: number,
  lat0: number,
): { kept: number; keptMinInset: number; culledFrontHemi: boolean } {
  let kept = 0
  let keptMinInset = Infinity
  let culledFrontHemi = false
  for (let dl = 0.2; dl <= 89; dl += 0.2) {
    for (const lat of [lat0 + dl, lat0 - dl]) {
      if (lat < -89.8 || lat > 89.8) continue
      const s = margin.projectLonLat(lon, lat)
      if (s) {
        kept++
        const inset = margin.limbInsetPx(s[0], s[1])
        if (inset < keptMinInset) keptMinInset = inset
      } else if (exact.projectLonLat(lon, lat)) {
        // exact keeps it (front hemisphere, in NDC bounds) but the label pass
        // dropped it → culled by the #1042 horizon-margin / limb-inset gate.
        culledFrontHemi = true
      }
    }
  }
  return { kept, keptMinInset, culledFrontHemi }
}

describe('ortho-telephoto globe label projector — projType 3/4/5 × tilt (#1051)', () => {
  const CLON = 10,
    CLAT = 30
  for (const azi of [3, 4, 5]) {
    for (const pitch of [45, 85]) {
      it(`azi${azi} pitch${pitch}: ×96 telephoto regime + centre + near-limb silhouette`, () => {
        const t = orthoTelephoto(azi, CLON, CLAT, 1.0, pitch, 1)
        // (i) Regime witness — prove we are on the ×96 telephoto matrix, not the
        //     perspective globe. ORTHO_TELE=96 pushes the eye HUNDREDS of R out
        //     (a perspective globe eye is < 15 R at this zoom), so cosH = R/|eye|
        //     → ~0 (the silhouette is a near great-circle — "visually parallel")
        //     and the far plane sits a FIXED 1.5 R past the eye, NOT the
        //     perspective (|eye|+R)·1.5 that scales with |eye|. Measured across
        //     3/4/5 × 45/85: D/R ∈ [288, 905], cosH ≤ 0.0035, (far−D)/R = 1.500.
        expect(t.D / EARTH_R, 'eye pushed back to the ×96 telephoto distance').toBeGreaterThan(100)
        expect(EARTH_R / t.D, 'near-parallel horizon (cosH → 0)').toBeLessThan(0.01)
        expect(
          Math.abs(t.far - t.D - 1.5 * EARTH_R),
          'tight ortho far bracket (globe.ts:267): far = |eye| + 1.5R',
        ).toBeLessThan(0.02 * EARTH_R)
        // (ii) View-centre dead-centre (EXACT projector — the no-cull path
        //      map.project() uses). Only the ellipsoid-anchor vs sphere-focus
        //      residual displaces it: ≤ ~0.8 px, inside CENTRE_TOL_PX.
        const c = t.exact.projectLonLat(CLON, CLAT)
        expect(c, 'view-centre anchor culled/off-screen').not.toBeNull()
        expect(Math.abs(c![0] - t.dw / 2), 'centre x off-centre').toBeLessThan(CENTRE_TOL_PX)
        expect(Math.abs(c![1] - t.dh / 2), 'centre y off-centre').toBeLessThan(CENTRE_TOL_PX)
        // (iii) Silhouette real (an off-disc screen corner reads a NEGATIVE
        //       inset — guards the sweep from passing vacuously on a null/
        //       +Infinity limb polygon) + no floating near-limb label.
        expect(
          t.margin.limbInsetPx(2, 2),
          'screen corner must be OUTSIDE the silhouette',
        ).toBeLessThan(0)
        const s = meridianLimbSweep(t.margin, t.exact, CLON, CLAT)
        expect(s.kept, 'front-hemisphere anchors must survive').toBeGreaterThan(10)
        expect(s.culledFrontHemi, 'label gate must cull the near-limb rim').toBe(true)
        expect(
          s.keptMinInset,
          'no kept near-limb label floats outside the silhouette',
        ).toBeGreaterThanOrEqual(LABEL_LIMB_INSET_PX)
      })
    }
  }

  it('zoom band 0–1.5: ortho (3) scale-frozen, azimuthal_eq (4) scales — centre stays centred', () => {
    // The azimuthal set opens at the wide-view zoom (viewport-mode-controller.ts:
    // 131 clamps to ≤ 1.5). Across that band the ORTHOGRAPHIC disc (3) is
    // scale-FROZEN — its altitude saturates at the flat cap 2·R (globe.ts:
    // 116-122), so the telephoto eye distance is identical at z0 and z1.5 —
    // while azimuthal_equidistant (4), whose cap is the far larger WORLD_MERC,
    // still scales with zoom. Both must keep the centre anchor dead-centre.
    const o0 = orthoTelephoto(3, CLON, CLAT, 0, 85, 1)
    const o15 = orthoTelephoto(3, CLON, CLAT, 1.5, 85, 1)
    // Orthographic altitude is capped → identical eye distance across the band
    // (measured D/R = 288.09 at both z0 and z1.5).
    expect(Math.abs(o0.D - o15.D) / EARTH_R, 'ortho disc is scale-frozen in 0–1.5').toBeLessThan(
      0.01,
    )
    const a0 = orthoTelephoto(4, CLON, CLAT, 0, 85, 1)
    const a15 = orthoTelephoto(4, CLON, CLAT, 1.5, 85, 1)
    // Azimuthal-equidistant cap (WORLD_MERC) is not reached in-band → the eye
    // distance moves (measured D/R 904.9 → 374.96, a ~530 R swing).
    expect(Math.abs(a0.D - a15.D) / EARTH_R, 'azimuthal_eq disc scales with zoom').toBeGreaterThan(
      1,
    )
    for (const t of [o0, o15, a0, a15]) {
      const c = t.exact.projectLonLat(CLON, CLAT)
      expect(c, 'centre anchor culled/off-screen').not.toBeNull()
      expect(
        Math.hypot(c![0] - t.dw / 2, c![1] - t.dh / 2),
        'centre off-centre across the zoom band',
      ).toBeLessThan(CENTRE_TOL_PX)
    }
  })
})
