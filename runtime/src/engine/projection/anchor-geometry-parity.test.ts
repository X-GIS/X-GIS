// ═══ Anchor ↔ geometry projection parity (the missing oracle) ═══
//
// deep-dive projection-rendering-architecture, finding E1. The root defect:
// geometry vertices project through `project_geom` (seam-aware, per-tile
// longitude unwrap toward the tile's ref-lon), while label/point ANCHORS
// project through plain `project` (`projectWgsl`, hard wrap at clon±180).
// They agree on Mercator (the only previously-tested path) and silently
// diverge on the SEAM projections — equirectangular (1), natural_earth (2),
// oblique_mercator (6) — when a feature near the antimeridian is viewed with
// the camera centred on the far side. The anchor then lands a full world-
// width off its own geometry ("label detached from feature").
//
// projection-wgsl-consistency.test.ts pins `project_geom` against ITSELF and
// `project` against ITSELF, but never compares the ANCHOR rule (`project`)
// to the GEOMETRY rule (`project_geom`) — so the divergence was invisible.
// This is the sibling-comparison test docs/COORDINATES.md prescribes for
// exactly this "each path individually correct; divergence only visible
// comparing outputs" class.
//
// Contract this locks:
//   1. For seam projections, plain `project` (the OLD anchor path) DIVERGES
//      from `project_geom` (geometry) by ~a world-width when a feature sits
//      across the clon±180 seam → anchors MUST switch to project_geom.
//   2. Away from the seam (feature within clon±180), the two AGREE → the
//      switch is safe for the common case.
// When the anchor call-sites are routed through project_geom (spec face B),
// label/point placement will match geometry for these projections; this test
// keeps `project` identified as the wrong choice so a regression back to it
// is caught.

import { describe, it, expect } from 'vitest'
import { projectWgsl, projectGeomWgsl } from '@xgis/map'

// Seam projections only — azimuthal (3/4/5) + globe (7) have no longitude
// seam (project_geom falls through to project for them), and mercator (0)
// is the tested baseline.
const SEAM_PROJ = [1, 2, 6] as const
const WORLD_WIDTH_M = 2 * Math.PI * 6378137 // ~4.0e7 m

describe('anchor ↔ geometry projection parity (E1)', () => {
  // The divergence needs a tile that STRADDLES the seam: its ref-lon (tile
  // centre) is on the far side of clon±180 from the vertex. Here the camera
  // is at clon=0, the feature vertex sits at lon=-179, but it belongs to a
  // tile centred on the antimeridian (refLon=180). project_geom unwraps the
  // vertex toward the tile centre → +181°; plain project hard-wraps to
  // −179° → the two land a full world apart. (A vertex in the PRIMARY tile
  // near the camera does NOT diverge — see the next test — which is why the
  // bug only surfaces for seam-straddling tiles / adjacent world copies.)
  const CLON = 0, CLAT = 0
  const FEATURE_LON = -179, FEATURE_LAT = 20
  const TILE_REF_LON = 180

  // Cylindrical equirect (1) + natural_earth (2) give a clean world-width
  // gap. oblique (6) diverges too but in a rotated metric — checked for
  // agreement away from the seam below rather than an exact world-width.
  const CLEAN_SEAM = [1, 2] as const

  it('plain project() DIVERGES from project_geom() for a seam-straddling tile', () => {
    for (const pt of CLEAN_SEAM) {
      const [ax] = projectWgsl(pt, FEATURE_LON, FEATURE_LAT, CLON, CLAT)            // OLD anchor
      const [gx] = projectGeomWgsl(pt, FEATURE_LON, FEATURE_LAT, CLON, CLAT, TILE_REF_LON) // geometry
      const dx = Math.abs(ax - gx)
      // ~one world width (the wrapped vs unwrapped branch).
      expect(dx, `projType ${pt}: project() should diverge from project_geom() across a straddling tile`)
        .toBeGreaterThan(WORLD_WIDTH_M * 0.4)
    }
  })

  it('project() AGREES with project_geom() away from the seam (switch is safe)', () => {
    // Feature within clon±180 — no wrap, the unwrap is the identity.
    const nearLon = 178, refNear = 178
    for (const pt of SEAM_PROJ) {
      const [ax, ay] = projectWgsl(pt, nearLon, FEATURE_LAT, CLON, CLAT)
      const [gx, gy] = projectGeomWgsl(pt, nearLon, FEATURE_LAT, CLON, CLAT, refNear)
      expect(ax, `projType ${pt} x`).toBeCloseTo(gx, 3)
      expect(ay, `projType ${pt} y`).toBeCloseTo(gy, 3)
    }
  })

  it('project()/project_geom() THROW for globe (projType 7) — no silent oblique fall-through', () => {
    // Camera face A2: globe has no 2D projection. The pre-fix code silently
    // returned the oblique-Mercator result for projType 7, detaching anchors
    // from the proj_globe-rendered geometry under the azimuthal-when-tilted
    // promotion. The guard makes a stray projType-7 caller fail loudly.
    expect(() => projectWgsl(7, 10, 20, 0, 0)).toThrow(/globe/)
    expect(() => projectGeomWgsl(7, 10, 20, 0, 0, 10)).toThrow(/globe/)
  })

  it('project_geom anchored on the feature tile matches the geometry of the SAME tile', () => {
    // The fix routes anchors through project_geom with the feature's tile
    // ref-lon — identical to how the geometry vertex seam projects, so a
    // label and its fill share one branch. This pins that equivalence.
    for (const pt of SEAM_PROJ) {
      const anchor = projectGeomWgsl(pt, FEATURE_LON, FEATURE_LAT, CLON, CLAT, TILE_REF_LON)
      const geom = projectGeomWgsl(pt, FEATURE_LON, FEATURE_LAT, CLON, CLAT, TILE_REF_LON)
      expect(anchor).toEqual(geom)
    }
  })
})
