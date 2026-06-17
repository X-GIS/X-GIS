// Regression: the delta-pan path (camera.pan — used by drag inertia and the
// above-horizon drag fallback) must move the camera centre the SAME way the
// drag-anchor path (panToScreenAnchor, which inverts the live MVP and is the
// definition of a correct pan) does, at every bearing.
//
// camera.pan rotated the screen delta by Rot(−bearing) instead of Rot(+bearing),
// so it was off by 2·bearing — coincidentally correct only at bearing 0/180.
// On a rotated map the inertia fling shot off at the wrong angle while the live
// drag (panToScreenAnchor) stayed correct (user report 2026-06-17).
//
// At pitch 0 the two paths are analytically identical (the linearised pan is
// exact when there is no perspective foreshortening), so the centre shifts must
// match to within MVP float noise. Pre-fix this FAILS at bearing ∈
// {30,45,90,135,270} (the perpendicular component flips sign); bearing 0/180
// are controls that pass either way.
import { describe, it, expect } from 'vitest'
import { Camera } from './camera'

const W = 1280, H = 800
const DX = 40, DY = 0 // a rightward cursor flick

describe('pan inertia/drag parity across bearing (pitch 0)', () => {
  for (const bearing of [0, 30, 45, 90, 135, 180, 270]) {
    it(`camera.pan matches panToScreenAnchor at bearing=${bearing}`, () => {
      // Path A — drag anchor (the correct contract). Grab the world point under
      // the screen centre (== camera centre at pitch 0), then move the cursor.
      const a = new Camera(2.35, 48.85, 14)
      a.projType = 0; a.globeMode = false; a.pitch = 0; a.bearing = bearing
      const ax0 = a.centerX, ay0 = a.centerY
      a.panToScreenAnchor(ax0, ay0, W / 2 + DX, H / 2 + DY, W, H)
      const dAx = a.centerX - ax0, dAy = a.centerY - ay0

      // Path B — delta pan (inertia uses this with the raw screen velocity).
      const b = new Camera(2.35, 48.85, 14)
      b.projType = 0; b.globeMode = false; b.pitch = 0; b.bearing = bearing
      const bx0 = b.centerX, by0 = b.centerY
      b.pan(DX, DY, W, H)
      const dBx = b.centerX - bx0, dBy = b.centerY - by0

      // Sub-metre tolerance: the bug produces a ~2·DY·mpp (~190 m) divergence,
      // far larger than the f32-MVP unproject noise (< 0.1 m).
      expect(dBx, `centreX shift @${bearing}`).toBeCloseTo(dAx, 1)
      expect(dBy, `centreY shift @${bearing}`).toBeCloseTo(dAy, 1)
    })
  }
})
