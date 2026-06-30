// Regression gate for the globe/ECEF label horizon cull (userbug 2026-06-01:
// "라벨이 지구 뒷면에 갔을 때 가려지지 못함" — far-hemisphere labels rendered
// THROUGH the globe on true-globe + pitched ortho/azi/stereo). The flat path
// already culls via needsBackfaceCullCpu; the ECEF/globe projector had no
// horizon cull. This pins makeLabelProjectors' `!flat` branch so a far-side
// anchor is occluded and a front anchor still projects.
//
// Pure CPU (buildGlobeMatrix + the projector math) — no GPU, so it runs under
// the standard vitest CI lane (the headed real-GPU eyeball that found the bug
// can't run in CI).
import { describe, it, expect } from 'vitest'
import { buildGlobeMatrix } from '@xgis/engine'
import { makeLabelProjectors } from './render-loop-helpers'

describe('makeLabelProjectors — globe/ECEF back-face label cull', () => {
  const W = 800, H = 600
  // Top-down globe centred at (lon 0, lat 0). The orbit eye sits on the +X
  // ECEF axis (the surface normal at lon0/lat0 at pitch 0), so the
  // camera-facing hemisphere is +X and the FAR hemisphere is −X (lon ±180).
  const view = buildGlobeMatrix(0, 0, 3, 0, 0, W, H)
  const eye = view.eye as [number, number, number]

  it('projects a FRONT-hemisphere anchor (dead-centre → screen centre)', () => {
    const { projectLonLat } = makeLabelProjectors(view.matrix, W, H, undefined, eye)
    const p = projectLonLat(0, 0)
    expect(p).not.toBeNull()
    expect(p![0]).toBeCloseTo(W / 2, 0)
    expect(p![1]).toBeCloseTo(H / 2, 0)
  })

  it('CULLS a FAR-hemisphere anchor (antipode behind the globe → null)', () => {
    const { projectLonLat } = makeLabelProjectors(view.matrix, W, H, undefined, eye)
    expect(projectLonLat(180, 0)).toBeNull()
    // A near-pole far-side point is also behind the visible hemisphere.
    expect(projectLonLat(180, 30)).toBeNull()
  })

  it('without eye the SAME far anchor is NOT horizon-culled (proves the cull does the work, not cw/NDC)', () => {
    const { projectLonLat } = makeLabelProjectors(view.matrix, W, H, undefined, undefined)
    // The antipode projects in front of the camera plane (cw>0) onto the disc
    // centre when the horizon cull is absent — exactly the bug. Supplying `eye`
    // (previous test) is what removes it.
    expect(projectLonLat(180, 0)).not.toBeNull()
  })
})
