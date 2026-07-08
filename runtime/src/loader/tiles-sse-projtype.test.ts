// Regression: the SSE selector must resolve `projType` from the
// authoritative PROJECTIONS table, NOT a `projection.name` ternary that
// collapses every disc/globe projection to equirectangular (projType 1).
//
// Equirectangular is cylindrical → worldCopiesFor(1) = [-2,-1,0,1,2], so a
// mis-resolved orthographic projection ran the DFS from 5 world-copy roots
// instead of 1. The off-world-copy roots evaluate `projection.forward()` at
// longitudes up to ±900° (copy ±2 → ±720° + 180°) on a NON-periodic disc,
// where the forward map is undefined/aliased. The authoritative table marks
// orthographic as SINGLE_WORLD = [0] (one root, |lon| ≤ ~180°).
//
// We can't read the resolved projType from the return value (the
// off-copy roots get frustum-culled, so emitted `ox` is masked to copy 0).
// Instead we spy on `projection.forward` and assert the selector never
// evaluates it outside a single world. Before the fix: maxAbsLon ≈ 900.
// After: maxAbsLon ≈ 180.

import { describe, expect, it } from 'vitest'
import { Camera } from '@xgis/map'
import { getProjection } from '@xgis/engine'
import { visibleTilesSSE } from '@xgis/data'

describe('visibleTilesSSE — projType resolution (single-world disc)', () => {
  it('orthographic evaluates projection.forward in a single world copy only', () => {
    const cam = new Camera(0, 20, 3)
    cam.pitch = 0
    cam.bearing = 0
    const ortho = getProjection('orthographic')

    let maxAbsLon = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = {
      ...ortho,
      forward(lon: number, lat: number): [number, number] {
        if (Math.abs(lon) > maxAbsLon) maxAbsLon = Math.abs(lon)
        return ortho.forward(lon, lat)
      },
    } as any

    visibleTilesSSE(cam, spy, 7, 1280, 800, 0, 1)

    // SINGLE_WORLD = [0] → the only world-copy root is 0, so the most
    // extreme longitude the selector ever reprojects is a primary-world
    // tile corner (≤ ~180°). The pre-fix 5-root DFS reached ±900°.
    expect(
      maxAbsLon,
      'orthographic is SINGLE_WORLD; the SSE selector must not evaluate ' +
        'projection.forward outside the primary world. A value near 900° ' +
        'means projType collapsed to equirectangular (worldCopiesFor → 5 roots).',
    ).toBeLessThanOrEqual(181)
  })
})
