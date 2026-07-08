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
import { makeLabelProjectors } from './render-loop-helpers'

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
