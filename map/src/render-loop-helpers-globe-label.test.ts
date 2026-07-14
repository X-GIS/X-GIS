// Regression: globe label anchors must project through the RTC (focus-relative)
// globe MVP as `e − focus`, the same camera-relative frame the geometry VS uses.
//
// makeLabelProjectors' `!flat` arm fed ABSOLUTE ECEF (`lonLatToECEF(lon,lat)`,
// magnitude ~6.37e6 m) straight into camera.getViewForProjection(7).matrix —
// which is the RTC matrix (buildGlobeMatrix subtracts the focus `target`). The
// missing focus subtraction splayed labels off their features and, under pitch,
// shot them off the top of the screen (the user's "labels float in space /
// vanish at z0+pitch" report). The pre-existing backface test never caught it
// because it passed the ABSOLUTE matrix, not the production rtcMatrix.
//
// The view-CENTRE anchor is the sharpest probe: its ECEF equals the RTC origin,
// so a correct projector puts it dead-centre on screen at ANY pitch. Without
// the focus subtraction it is thrown far off (off-screen under pitch).
import { describe, it, expect } from 'vitest'
import { Camera } from './camera'
import { makeLabelProjectors, LABEL_LIMB_INSET_PX } from './render-loop-helpers'

const W = 800,
  H = 600

function projectCentre(pitch: number, withFocus: boolean): [number, number] | null {
  const cam = new Camera(127, 37, 0) // Seoul, zoom 0
  cam.projType = 7
  cam.globeMode = true
  cam.pitch = pitch
  const view = cam.getViewForProjection(7, W, H, 1)
  const proj = makeLabelProjectors(
    view.matrix,
    W,
    H,
    undefined,
    view.eye,
    withFocus ? cam.getECEFCenter() : undefined,
  )
  return proj.projectLonLat(127, 37) // the camera centre
}

describe('globe label projector — RTC focus anchoring', () => {
  for (const pitch of [0, 45, 60]) {
    it(`view-centre anchor projects to screen centre at pitch=${pitch}`, () => {
      const p = projectCentre(pitch, true)
      expect(p, `centre anchor culled/off-screen at pitch ${pitch}`).not.toBeNull()
      // Dead-centre within a few px (ellipsoid-vs-sphere residual is sub-px).
      expect(Math.abs(p![0] - W / 2), `x off-centre @${pitch}`).toBeLessThan(6)
      expect(Math.abs(p![1] - H / 2), `y off-centre @${pitch}`).toBeLessThan(6)
    })
  }

  it('WITHOUT the focus subtraction the pitched centre anchor is thrown off-centre (the bug)', () => {
    // Pins the defect: absolute ECEF into the RTC matrix mis-places the anchor.
    const buggy = projectCentre(60, false)
    const fixed = projectCentre(60, true)
    expect(fixed).not.toBeNull()
    // Either culled (null) or far from centre — never the correct centred spot.
    const offCentre = buggy === null || Math.hypot(buggy[0] - W / 2, buggy[1] - H / 2) > 50
    expect(offCentre, `buggy path should be off-centre but got ${JSON.stringify(buggy)}`).toBe(true)
  })
})

// ── #1051 — extreme-pitch band (75/85) × wide-view zoom (0–1.5) ───────────────
// The controller clamps pitch to [0,85] (controller.ts:336,403) but the block
// above only probed the centre anchor up to pitch 60. The RTC focus anchoring is
// pitch-INVARIANT by construction — the orbit camera's lookAt TARGET is the RTC
// origin the label matrix subtracts, so the view-centre anchor projects to NDC 0
// (screen centre) at ANY pitch — yet the horizon-margin + screen-space limb-inset
// label gate (#1042) is most stressed exactly here, at the shallow grazing
// pitches where the disc foreshortens to a thin cap. These cases pin both facts
// across the wide-view zoom band the globe/azimuthal set opens in
// (viewport-mode-controller.ts:131 clamps to ≤ 1.5):
//   • the view-centre anchor stays dead-centre (EXACT projector — the no-cull
//     path the block above and map.project() use);
//   • under the LABEL projector, no kept near-limb anchor floats past the
//     projected globe silhouette (every kept anchor's limb inset ≥
//     LABEL_LIMB_INSET_PX) while the gate still culls the beyond-limb rim.

// Centre-anchor tolerance (device px). The only displacement of the dead-centre
// anchor is the ellipsoid-anchor vs sphere-focus geodetic residual (the anchor is
// lonLatToECEF on the WGS84 ellipsoid; the focus/target ride the sphere of radius
// A) — a fixed metre offset that projects to ≤ ~0.5 px at DPR 1 and ~2× that at
// DPR 2 (device-pixel doubling), for every zoom/pitch here. 2 px covers DPR 2 +
// float32-MVP rounding. (measured: ≤ 0.46 px @DPR1, ≤ 0.93 px @DPR2.)
const CENTRE_TOL_PX = 2

/** Build the perspective-globe label projectors (exact + label-pass) for a Seoul
 *  centre at the given zoom/pitch/DPR, through the SAME public path the render
 *  loop uses (getViewForProjection(7,…) → the ECEF/globe MVP). `dw/dh` are the
 *  device-pixel framebuffer dimensions the NDC→screen map spans. */
function perspGlobeCase(zoom: number, pitch: number, dpr: number) {
  const cam = new Camera(127, 37, zoom) // Seoul — same fixture as the block above
  cam.projType = 7
  cam.globeMode = true
  cam.pitch = pitch
  const dw = Math.round(W * dpr)
  const dh = Math.round(H * dpr)
  const view = cam.getViewForProjection(7, dw, dh, dpr)
  const focus = cam.getECEFCenter()
  return {
    dw,
    dh,
    exact: makeLabelProjectors(view.matrix, dw, dh, undefined, view.eye, focus, false),
    margin: makeLabelProjectors(view.matrix, dw, dh, undefined, view.eye, focus, true),
  }
}

/** Sweep the tilt meridian (lon = centre lon; bearing 0 tilts along it) and, under
 *  the LABEL-pass projector, report how many anchors it KEEPS, the smallest limb
 *  inset among those kept (the anchor nearest the limb), and whether the label
 *  gate CULLED any front-hemi in-bounds anchor. A 0.2° step lands a sample within
 *  ~1 px of the limb at these disc sizes. */
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

function assertCentreAndSilhouette(
  c: ReturnType<typeof perspGlobeCase>,
  lon: number,
  lat: number,
): void {
  // 1. View-centre dead-centre (EXACT projector — no cull, like the block above).
  const centre = c.exact.projectLonLat(lon, lat)
  expect(centre, 'view-centre anchor culled/off-screen').not.toBeNull()
  expect(Math.abs(centre![0] - c.dw / 2), 'centre x off-centre').toBeLessThan(CENTRE_TOL_PX)
  expect(Math.abs(centre![1] - c.dh / 2), 'centre y off-centre').toBeLessThan(CENTRE_TOL_PX)
  // 2. The projected silhouette is a REAL bounded polygon: an off-disc screen
  //    corner reads a NEGATIVE inset (outside). Guards the sweep below from
  //    passing vacuously on a degenerate (null → +Infinity) limb polygon.
  expect(c.margin.limbInsetPx(2, 2), 'screen corner must be OUTSIDE the silhouette').toBeLessThan(0)
  // 3. Near-limb: every anchor the label pass KEEPS on the tilt meridian sits
  //    ≥ LABEL_LIMB_INSET_PX inside the silhouette (no floating label), and the
  //    gate actively culls the near-limb rim.
  const s = meridianLimbSweep(c.margin, c.exact, lon, lat)
  expect(s.kept, 'front-hemisphere anchors must survive').toBeGreaterThan(10)
  expect(s.culledFrontHemi, 'label gate must cull the near-limb rim').toBe(true)
  expect(
    s.keptMinInset,
    'no kept near-limb label floats outside the silhouette',
  ).toBeGreaterThanOrEqual(LABEL_LIMB_INSET_PX)
}

describe('globe label projector — extreme-pitch band 75/85 × zoom 0–1.5 (#1051)', () => {
  for (const zoom of [0, 0.75, 1.5]) {
    for (const pitch of [75, 85]) {
      it(`centre dead-centre + near-limb inside silhouette — z${zoom} pitch${pitch}`, () => {
        assertCentreAndSilhouette(perspGlobeCase(zoom, pitch, 1), 127, 37)
      })
    }
  }

  it('DPR 2: centre residual stays sub-2px as device pixels double (z1.5 pitch85)', () => {
    // The centre residual is a metre offset projected to DEVICE px, so it scales
    // with DPR: ~0.34 px at DPR 1 → ~0.69 px at DPR 2 here (measured) — still far
    // inside the 2 px budget. Same near-limb silhouette guarantee at 1600×1200.
    assertCentreAndSilhouette(perspGlobeCase(1.5, 85, 2), 127, 37)
  })
})
