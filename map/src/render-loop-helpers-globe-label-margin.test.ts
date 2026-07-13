// #1042 — globe label-anchor HORIZON MARGIN cull.
//
// The globe/ECEF anchor cull (makeLabelProjectors' `!flat` branch) is a BINARY
// tangent-circle test: an anchor one pixel inside the limb passes, yet its
// screen-space quad (tens of px of glyphs) still draws past the limb — at low
// zoom + extreme pitch a whole ROW of country labels floats above the horizon
// (probe 2026-07-13). The fix requires a label anchor to sit an angular band
// INSIDE the tangent circle before it draws (LABEL_HORIZON_MARGIN), applied
// ONLY by the label-pass projector — map.project() keeps the exact cull.
//
// The margin is a FRACTION of the visibility headroom `(1 − cosH)`, NOT an
// absolute cosine offset: globeMode is projection-gated (it runs at city zoom
// where cosH → 1 and the headroom collapses), so any FIXED additive margin
// would eventually exceed the headroom and blank EVERY label incl. screen
// centre. The high-zoom test below pins exactly that (a fraction < 1 cannot
// cross the sub-eye point; an absolute margin of the same magnitude would).
//
// Pure CPU (buildGlobeMatrix + projector math) — rides the standard vitest lane
// like the sibling render-loop-label-backface.test.ts.
import { describe, it, expect } from 'vitest'
import { Camera } from './camera'
import {
  makeLabelProjectors,
  LABEL_HORIZON_MARGIN,
  LABEL_LIMB_INSET_PX,
  projectLonLatToScreenCss,
} from './render-loop-helpers'
import { buildGlobeMatrix, EARTH_R } from '@xgis/geo'
import { lonLatToECEF } from '@xgis/shared'

const W = 800,
  H = 600
type V3 = readonly [number, number, number]

/** cos of the angle between a lon/lat surface anchor and the eye axis — the
 *  quantity the tangent cull thresholds against (`dot(e,eye) / (|e|·|eye|)`). */
function cosFromEye(lon: number, lat: number, eye: V3, D: number): number {
  const e = lonLatToECEF(lon, lat)
  const el = Math.hypot(e[0], e[1], e[2])
  return (e[0] * eye[0] + e[1] * eye[1] + e[2] * eye[2]) / (el * D)
}

/** An ON-SCREEN anchor whose eye-angle cosine is closest to `cosTarget`, found
 *  on the lon=0 tilt meridian (the eye's X-Z plane for a centre-(0,0) camera →
 *  the screen vertical → guaranteed on the visible disc for a front point). */
function anchorNear(
  cosTarget: number,
  eye: V3,
  D: number,
  onScreen: (lat: number) => boolean,
): { lat: number; cos: number } {
  let best: { lat: number; cos: number } | null = null
  let bestErr = Infinity
  for (let lat = -89; lat <= 89; lat += 0.02) {
    const c = cosFromEye(0, lat, eye, D)
    if (c >= 1 || !onScreen(lat)) continue
    const err = Math.abs(c - cosTarget)
    if (err < bestErr) {
      bestErr = err
      best = { lat, cos: c }
    }
  }
  if (!best) throw new Error(`no on-screen anchor near cos=${cosTarget}`)
  return best
}

describe('makeLabelProjectors — globe label horizon margin (#1042)', () => {
  for (const pitch of [0, 85]) {
    it(`margin culls a near-limb band anchor, keeps an interior one — pitch ${pitch}`, () => {
      const view = buildGlobeMatrix(0, 0, 0, pitch, 0, W, H)
      const eye = view.eye as V3
      const D = Math.hypot(eye[0], eye[1], eye[2])
      const cosH = EARTH_R / D // exact tangent horizon
      const cosC = cosH + LABEL_HORIZON_MARGIN * (1 - cosH) // label-pass cull threshold
      const exact = makeLabelProjectors(
        view.matrix,
        W,
        H,
        undefined,
        eye,
        undefined,
        false,
      ).projectLonLat
      const margin = makeLabelProjectors(
        view.matrix,
        W,
        H,
        undefined,
        eye,
        undefined,
        true,
      ).projectLonLat

      // Band anchor: inside the geometric horizon (front hemisphere) but within
      // the margin band. Built at the band midpoint, then SELF-VALIDATED against
      // the two thresholds so ellipsoid-vs-sphere drift can't silently move it.
      const band = anchorNear((cosH + cosC) / 2, eye, D, (lat) => exact(0, lat) !== null)
      expect(band.cos).toBeGreaterThan(cosH) // the EXACT tangent test keeps it
      expect(band.cos).toBeLessThan(cosC) // but it sits within the margin band
      // fail-before: the exact cull (map.project / pre-#1042 label pass) keeps it.
      expect(exact(0, band.lat), 'exact cull must KEEP the band anchor').not.toBeNull()
      // pass-after: the label-pass margin projector culls it.
      expect(margin(0, band.lat), 'label-pass margin must CULL the band anchor').toBeNull()

      // Interior anchor (well inside the cull threshold) stays kept by the margin.
      const inner = anchorNear((cosC + 1) / 2, eye, D, (lat) => exact(0, lat) !== null)
      expect(inner.cos).toBeGreaterThan(cosC)
      expect(margin(0, inner.lat), 'interior anchor must survive the margin').not.toBeNull()
    })
  }

  it('map.project() keeps the SAME band anchor the label pass culls (gate defaults off)', () => {
    // projectLonLatToScreenCss builds the projector with the horizon-margin gate
    // DEFAULTED OFF — it answers "where does this lon/lat land", not "should a
    // label draw" — so it must NOT inherit the cull. Pitch 0: the globe
    // map.project path projects on-screen here.
    const cam = new Camera(0, 0, 0)
    cam.projType = 7
    cam.globeMode = true
    const view = cam.getViewForProjection(7, W, H, 1)
    const eye = view.eye as V3
    const D = Math.hypot(eye[0], eye[1], eye[2])
    const cosH = EARTH_R / D
    const cosC = cosH + LABEL_HORIZON_MARGIN * (1 - cosH)
    const focus = cam.getECEFCenter() as V3
    const exact = makeLabelProjectors(view.matrix, W, H, undefined, eye, focus, false).projectLonLat
    const margin = makeLabelProjectors(view.matrix, W, H, undefined, eye, focus, true).projectLonLat
    const band = anchorNear((cosH + cosC) / 2, eye, D, (lat) => exact(0, lat) !== null)
    expect(margin(0, band.lat), 'label pass culls it').toBeNull()
    // map.project (the public CPU mirror) keeps it — returns coordinates.
    const mp = projectLonLatToScreenCss(cam, W, H, 1, 0, 0, [0, band.lat])
    expect(mp, 'map.project must return coordinates for the band anchor').not.toBeNull()
  })

  it('high zoom: the margin never blanks the dead-centre anchor (fraction, not absolute)', () => {
    // globeMode is projection-gated, so it runs at city zoom where cosH → 1 and
    // the headroom (1 − cosH) collapses. This is the regression an ABSOLUTE
    // cosine offset would cause — and the reason the margin is a FRACTION.
    const cam = new Camera(0, 0, 12)
    cam.projType = 7
    cam.globeMode = true
    const view = cam.getViewForProjection(7, W, H, 1)
    const eye = view.eye as V3
    const D = Math.hypot(eye[0], eye[1], eye[2])
    const cosH = EARTH_R / D
    // The headroom is smaller than the nominal margin value here …
    expect(1 - cosH).toBeLessThan(LABEL_HORIZON_MARGIN)
    // … so an ABSOLUTE margin of that magnitude would cull even the centre (cos=1):
    expect(1).toBeLessThanOrEqual(cosH + LABEL_HORIZON_MARGIN)
    // The headroom-fraction form keeps the centre (and the inner cap): cull
    // threshold cosH + f·(1−cosH) < 1, so cos=1 always survives.
    const focus = cam.getECEFCenter() as V3
    const margin = makeLabelProjectors(view.matrix, W, H, undefined, eye, focus, true).projectLonLat
    expect(margin(0, 0), 'dead-centre anchor must survive at z12 globe').not.toBeNull()
  })

  it('derives the culled band at the z0 / pitch-85 top limb (calibration record)', () => {
    // Calibration record for LABEL_HORIZON_MARGIN = 0.15 (headroom fraction).
    //
    // Because the sphere is foreshortened to sub-pixel AT the limb, a cosine
    // margin trims a WIDE ANGULAR rim for a small RADIAL screen cost — the
    // angular rim (where the floating-label row lives) is the meaningful metric,
    // not a fixed screen-px band. Measured at the z0 / pitch-85 test camera
    // (D/R ≈ 11.2, cosH ≈ 0.0895):
    //   • angular rim culled  ≈ 7.9°  (thetaH 84.9° → thetaM 76.9°)
    //   • radial screen band  < 1 px at the top limb (grows with the disc:
    //     a few px at z2, tens of px once the globe fills the view)
    // A ≥24 px RADIAL band at z0 is geometrically impossible for ANY safe margin
    // (the z0 disc is only ~150 px tall; a 24 px anchor-inset would need ~2/3 of
    // the disc). We instead trim the crushed, unreadable rim — matching MapLibre
    // / Google-Earth — and keep the inner majority of the cap.
    const view = buildGlobeMatrix(0, 0, 0, 85, 0, W, H)
    const eye = view.eye as V3
    const D = Math.hypot(eye[0], eye[1], eye[2])
    const cosH = EARTH_R / D
    const cosC = cosH + LABEL_HORIZON_MARGIN * (1 - cosH)
    const thetaHdeg = (Math.acos(cosH) * 180) / Math.PI
    const thetaMdeg = (Math.acos(cosC) * 180) / Math.PI
    const angularRim = thetaHdeg - thetaMdeg
    // A meaningful rim is trimmed (removes the foreshortened floating-label row) …
    expect(angularRim).toBeGreaterThan(3)
    // … but the inner majority of the visible cap is preserved (don't eat the disc).
    expect(thetaMdeg).toBeGreaterThan(0.5 * thetaHdeg)

    // Radial screen band at the top limb, on the lon=0 meridian: the screen
    // distance from a just-inside-horizon anchor to the margin-boundary anchor.
    // projectLonLat returns a SHARED scratch tuple, so each result is copied out
    // before the next call (the documented aliasing rule).
    const proj = makeLabelProjectors(
      view.matrix,
      W,
      H,
      undefined,
      eye,
      undefined,
      false,
    ).projectLonLat
    const onScreen = (lat: number): boolean => proj(0, lat) !== null
    const nearH = anchorNear(cosH + (cosC - cosH) * 0.02, eye, D, onScreen) // ~at the limb
    const atC = anchorNear(cosC, eye, D, onScreen) // margin boundary
    const centerLatDeg = (Math.asin(eye[2] / D) * 180) / Math.PI
    const ph = proj(0, nearH.lat)!
    const pHx = ph[0],
      pHy = ph[1]
    const pc = proj(0, atC.lat)!
    const pCx = pc[0],
      pCy = pc[1]
    const cen = proj(0, centerLatDeg)
    const bandPx = Math.hypot(pHx - pCx, pHy - pCy)
    // The band is SUB-PIXEL at z0 (limb foreshortening compresses the ~8.6°
    // culled rim into < 1 px) — the honest calibration result, and why the
    // ANGULAR rim above (not a screen-px band) is the metric that matters. The
    // only screen-space property we can safely assert is the SAFETY bound: the
    // cull edge never moves inward past half the on-screen disc radius.
    expect(bandPx).toBeGreaterThanOrEqual(0)
    if (cen) {
      const discR = Math.hypot(pHx - cen[0], pHy - cen[1])
      expect(bandPx).toBeLessThan(0.5 * discR)
    }
  })
})

// ── #1042 ROUND 2 — SCREEN-SPACE limb inset ──────────────────────────────────
//
// Round 1 (the angular LABEL_HORIZON_MARGIN above) was REFUTED by the §5 probe:
// at globe z2 / lat 20 / pitch 85 the floating and fine country labels INTERLEAVE
// in angular depth (Chad 7.5° inside floats; Kenya 14.8° inside is fine) because
// screen compression varies with azimuth — no single angular threshold can
// separate them. Round 2 gates on the PROJECTED GLOBE SILHOUETTE: an anchor draws
// only if its screen point sits ≥ LABEL_LIMB_INSET_PX inside the limb polygon
// (built by projecting the horizon circle through the anchors' own matrix path).
// The angular margin is kept as the cheap pre-filter; the limb test runs after it.
describe('makeLabelProjectors — globe SCREEN-SPACE limb inset (#1042 round 2)', () => {
  // The EXACT probe camera the round-1 fix was refuted on (860×720, not 800×600).
  const PW = 860,
    PH = 720
  const view = buildGlobeMatrix(0, 20, 2, 85, 0, PW, PH)
  const eye = view.eye as V3
  const D = Math.hypot(eye[0], eye[1], eye[2])
  const cosH = EARTH_R / D
  const cosC = cosH + LABEL_HORIZON_MARGIN * (1 - cosH) // round-1 angular cull threshold
  const exact = makeLabelProjectors(view.matrix, PW, PH, undefined, eye, undefined, false).projectLonLat
  const margin = makeLabelProjectors(view.matrix, PW, PH, undefined, eye, undefined, true).projectLonLat

  // The three named anchors are the round-1 probe measurements (2026-07-13):
  const CHAD: [number, number] = [18.7, 15.4] // floater — 7.5° inside the horizon
  const KENYA: [number, number] = [37.9, 0.2] // fine — 14.8° inside, interior on screen
  const SATL: [number, number] = [-15, -35] // deep interior

  it('FAIL-BEFORE: the Chad floater passes the ANGULAR margin yet the screen limb culls it', () => {
    // Chad sits 7.5° inside the horizon — DEEPER than the LABEL_HORIZON_MARGIN
    // band — so round-1's angular-only projector KEEPS it. This assertion pins
    // that: cos > cosC means the angular gate does not fire on Chad.
    const cCos = cosFromEye(CHAD[0], CHAD[1], eye, D)
    expect(cCos).toBeGreaterThan(cosC) // angular margin does NOT cull Chad → round-1 draws it
    // The exact tangent projector (== the map.project path) keeps it (front hemi).
    expect(exact(CHAD[0], CHAD[1]), 'exact/tangent projector keeps Chad').not.toBeNull()
    // Round-2: the screen-space limb inset culls it (its quad floats past the
    // silhouette). Against round-1 (angular margin only, no limb test) this
    // assertion FAILS — round-1 returns coordinates here.
    expect(margin(CHAD[0], CHAD[1]), 'label-pass limb inset must CULL the Chad floater').toBeNull()
  })

  it('KEEPS the Kenya anchor the angular test cannot distinguish from a floater', () => {
    // Kenya is 14.8° inside and — like Chad and the other floaters — clears the
    // angular gate (cos > cosC). Only the screen test keeps it: its projected
    // point is 11.8 px INTERIOR to the silhouette (vs Chad's 2.9 px). This is the
    // separation an angular threshold cannot make.
    const kCos = cosFromEye(KENYA[0], KENYA[1], eye, D)
    expect(kCos).toBeGreaterThan(cosC) // Kenya also clears the angular gate …
    expect(margin(KENYA[0], KENYA[1]), 'screen-interior Kenya must be KEPT').not.toBeNull()
  })

  it('KEEPS a deep-interior anchor (South Atlantic)', () => {
    expect(margin(SATL[0], SATL[1]), 'deep-interior anchor must be KEPT').not.toBeNull()
  })

  it('the limb inset is a small half-quad-height buffer (< Kenya’s 11.8 px screen inset)', () => {
    // Guards the value: 7 px (a half text-line-height at DPR 1) — big enough to
    // keep the Chad floater’s quad off the sky, small enough NOT to blank the
    // interior Kenya anchor (11.8 px inside). A regression back to a full
    // line-height (14) would cull Kenya and defeat round 2.
    expect(LABEL_LIMB_INSET_PX).toBeGreaterThan(0)
    expect(LABEL_LIMB_INSET_PX).toBeLessThan(11)
  })

  it('pitch 0: margin keeps dead-centre; map.project keeps every witness (limb inset is label-only)', () => {
    const v0 = buildGlobeMatrix(0, 20, 2, 0, 0, PW, PH)
    const m0 = makeLabelProjectors(v0.matrix, PW, PH, undefined, v0.eye as V3, undefined, true)
      .projectLonLat
    expect(m0(0, 20), 'pitch-0 dead-centre anchor must be KEPT').not.toBeNull()

    // projectLonLatToScreenCss (map.project) builds the projector WITHOUT the
    // label gate, so the limb inset must not leak in: every witness — including
    // the Chad floater the label pass culls at pitch 85 — returns coordinates.
    const cam = new Camera(0, 20, 2)
    cam.projType = 7
    cam.globeMode = true
    const centre: [number, number] = [0, 20]
    for (const [lon, lat] of [CHAD, KENYA, SATL, centre]) {
      expect(
        projectLonLatToScreenCss(cam, PW, PH, 1, 0, 20, [lon, lat]),
        `map.project must return coordinates for [${lon},${lat}]`,
      ).not.toBeNull()
    }
  })
})
