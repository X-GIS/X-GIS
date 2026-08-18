// ═══ atmosphereCameraRays — CPU camera-ray extraction (#1258) ═══
//
// Two real-math cases, not a mock of `invert4x4`: a pure symmetric perspective
// projection (no view translation — the camera sits at the object-space origin) has an
// analytically known eye, `(0, 0, 0)`, because the whole matrix carries no translation
// term; a pure orthographic (affine) matrix has NO finite eye at all (`w_clip` never
// crosses zero along any ray) and must return `null`, the same "no usable camera ray
// field" contract `field-lattice-uniform.ts`'s `cornerRays` documents for its own
// near-degenerate case.

import { describe, it, expect } from 'vitest'
import { atmosphereCameraRays } from './atmosphere-uniform'

/** A symmetric OpenGL-style perspective projection, column-major, NO view/translation —
 *  `w_clip = -z` exactly, so the eye (where `w_clip` crosses zero) sits at the object-space
 *  origin by construction. */
function perspectiveOnly(near: number, far: number, f: number): Float32Array {
  return new Float32Array([
    f,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) / (near - far),
    -1,
    0,
    0,
    (2 * far * near) / (near - far),
    0,
    // prettier-ignore
  ])
}

describe('atmosphereCameraRays', () => {
  it('a pure perspective projection (no translation) has its eye at the origin', () => {
    const rays = atmosphereCameraRays(perspectiveOnly(1, 100, 1))
    expect(rays).not.toBeNull()
    expect(rays!.eye).toEqual([0, 0, 0])
    // Four DISTINCT corner directions, all pointing away from the eye (nonzero) — the
    // camera-ray field this pass draws with, not a degenerate all-same-direction blend.
    expect(new Set(rays!.dirs.map((d) => d.join(','))).size).toBe(4)
    for (const d of rays!.dirs) {
      expect(Math.hypot(d[0], d[1], d[2])).toBeGreaterThan(0)
    }
  })

  it('an orthographic (affine, no perspective term) matrix has no finite eye — null', () => {
    // w_clip is CONSTANT (1) along every ray: no point zeroes it, so there is no eye to
    // solve for. The same contract atmosphere-pass.ts's own execute() no-ops on.
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    expect(atmosphereCameraRays(identity)).toBeNull()
  })
})
