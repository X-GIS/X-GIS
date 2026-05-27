// Unit tests for polygon-mesh utilities.
//
// The Mercator-DSFUN `quantizePolygonVertices(Extruded)` + `generateWallMesh
// (Extruded)` paths were retired in Phase 2 PR 2c.2 — runtime polygon
// vertices now ship as ECEF-DSFUN stride-9 directly from the tiler, and the
// extruded wall + roof mesh comes from `generateWallMeshExtrudedECEF`
// (covered by `polygon-mesh-ecef.test.ts`). The smoke test below pins the
// `EXTRUDE_FALLBACK_HEIGHT_M` constant — it's read by both the polygon-mesh
// path and the line-outline z_lift; divergence has previously shown up as
// patchy building outlines.

import { describe, expect, it } from 'vitest'
import { EXTRUDE_FALLBACK_HEIGHT_M } from './polygon-mesh'

describe('EXTRUDE_FALLBACK_HEIGHT_M', () => {
  it('exports a numeric default height', () => {
    expect(typeof EXTRUDE_FALLBACK_HEIGHT_M).toBe('number')
    expect(EXTRUDE_FALLBACK_HEIGHT_M).toBeGreaterThan(0)
  })
})
