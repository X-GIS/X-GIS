import { describe, it, expect } from 'vitest'
import { routeToSphereSelector, promotesToGlobeWhenTilted, PROJECTIONS } from '@xgis/geo'

// ═══ CHARACTERIZATION: oblique_mercator(6) tilt-promotion gap ═══
//
// This test DOCUMENTS current behaviour — it does NOT assert the intended
// fix. Surfaced by the camera+tileselect audit and made explicit by the P1
// authority flip: two table-derived predicates disagree about oblique(6).
//
//   routeToSphereSelector(6)      → TRUE   (6 uses the sphere-aware tile
//                                           selector — it projects relative
//                                           to the camera centre)
//   promotesToGlobeWhenTilted(6)  → FALSE  (6 is cylindrical, so it is NOT
//                                           in the azimuthal tilt-promotion
//                                           set {3,4,5}; render-loop keeps
//                                           projType 6 → flat MVP at pitch>0)
//
// Net: at pitch>0, oblique_mercator draws with a FLAT Mercator-metre MVP
// while its tiles come from the SPHERE selector. This predicate DISAGREEMENT
// is real (asserted below) — but P-A1 (2026-07-17) REFUTED the "broken 3D at
// pitch>0" reading: the flat-MVP and sphere-tile camera models AGREE to
// ≤4.0px @pitch15 / 7.1px @pitch60 on 2582–4926px tiles (~0.15%), NOT pitch-
// gated (UNDER-SELECTED=0 at every pitch), so 6 stays flat-MVP on purpose and
// the selector under-refines nothing. The oblique(6) fill softness was H2 (the
// fixed-res #599 bake→drape), fixed by EXCLUDING 6 from bakesVectorDrape — a
// render-SURFACE flip that leaves this SELECTION-level disagreement (and these
// asserts) intact. This test still fails loudly only if someone changes one
// predicate without the other — keeping the decision visible.

describe('oblique_mercator(6) tilt-promotion characterization (documents a known gap)', () => {
  it('oblique(6) sphere-routes its tiles but is NOT promoted when tilted (the gap)', () => {
    expect(routeToSphereSelector(6, false)).toBe(true) // sphere tile selector
    expect(promotesToGlobeWhenTilted(6)).toBe(false) // but flat MVP at pitch>0
    // The inconsistency itself, asserted as the documented current state:
    expect(routeToSphereSelector(6, false) && !promotesToGlobeWhenTilted(6)).toBe(true)
  })

  it('the azimuthal family (3/4/5) is CONSISTENT — both sphere-routes and promotes', () => {
    for (const pt of [3, 4, 5]) {
      expect(routeToSphereSelector(pt, false)).toBe(true)
      expect(promotesToGlobeWhenTilted(pt)).toBe(true)
    }
  })

  it('flat (0/1/2) and globe (7) neither promote nor (for flat) sphere-route', () => {
    for (const pt of [0, 1, 2]) {
      expect(routeToSphereSelector(pt, false)).toBe(false)
      expect(promotesToGlobeWhenTilted(pt)).toBe(false)
    }
    // Globe (7) reaches the sphere path via globeMode, not these predicates.
    expect(promotesToGlobeWhenTilted(7)).toBe(false)
    expect(routeToSphereSelector(7, false)).toBe(false)
  })

  it('promotesToGlobeWhenTilted derives !isFlat && !isGlobe && !isCylindrical from the table', () => {
    for (const p of PROJECTIONS) {
      const expected = !p.isFlat && !p.isGlobe && !p.isCylindrical
      expect(promotesToGlobeWhenTilted(p.projType)).toBe(expected)
    }
  })
})
