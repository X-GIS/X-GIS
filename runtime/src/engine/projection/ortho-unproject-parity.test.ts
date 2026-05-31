// Orthographic render↔unproject cap parity (commit fc0fc19d review Q3).
//
// The 2.1 fix caps ortho's flat MVP view height at 2·EARTH_R via the RENDER
// entry point (getViewForProjection → getFrameView). The INVERSE entry point
// (unprojectToZ0 → getRTCMatrixInverse) must use the SAME cap, else ortho
// screen→world unprojection describes a different camera than the render —
// off by the cap ratio WORLD_MERC/2R ≈ π. This pins that the two PRODUCTION
// paths agree: unproject a screen point, forward-project it back through the
// render MVP, and assert it returns to the original pixel. A revert of the
// getRTCMatrixInverse cap (back to the WORLD_MERC default) drifts the
// round-trip by ~π at low zoom and fails this.

import { describe, it, expect } from 'vitest'
import { Camera } from './camera'

const W = 800, H = 800, DPR = 1

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

describe('ortho render↔unproject cap parity (z0 disc fix)', () => {
  // z 0/1/2 are below the cap-unbind zoom (~2.295 at 800px), so ortho's 2R cap
  // actively differs from the WORLD_MERC default the inverse used before the
  // fix — these zooms catch a regression; above ~2.3 both caps equal rawVH.
  for (const zoom of [0, 1, 2]) {
    it(`ortho screen→world→screen round-trips at z=${zoom} p0`, () => {
      const cam = new Camera(0, 0, zoom)
      cam.pitch = 0
      cam.bearing = 0
      cam.projType = 3
      cam.globeMode = false
      cam.globeOrtho = true

      // An off-centre screen point (asymmetric in both axes).
      const sx = 560, sy = 300
      const world = cam.unprojectToZ0(sx, sy, W, H, DPR)
      expect(world, `unproject returned null at z=${zoom}`).not.toBeNull()

      // Forward-project the unprojected world point through the RENDER MVP.
      const mvp = cam.getViewForProjection(3, W, H, DPR).matrix
      const clip = mulMat4Vec4(mvp, [world![0], world![1], 0, 1])
      expect(clip[3], `behind camera at z=${zoom}`).toBeGreaterThan(1e-6)
      const backX = (clip[0] / clip[3] + 1) * 0.5 * W
      const backY = (1 - clip[1] / clip[3]) * 0.5 * H

      // Round-trips to the original pixel only if unproject + render share the
      // ortho 2R cap. With the pre-fix WORLD_MERC inverse, backX/backY would be
      // off by ≈π.
      expect(backX, `x drift at z=${zoom}`).toBeCloseTo(sx, 0)
      expect(backY, `y drift at z=${zoom}`).toBeCloseTo(sy, 0)
    })
  }
})
