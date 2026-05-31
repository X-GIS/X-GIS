import { describe, it, expect } from 'vitest'
import {
  PROJECTIONS,
  PROJECTION_NAME_TO_TYPE,
  SELECTOR_PROJ_NAMES,
} from './projections-table'
import { worldCopiesFor, enumerateWorldCopies, routeToSphereSelector } from '../gpu/gpu-shared'

// The PROJECTIONS table is the SINGLE SOURCE OF TRUTH (authority flip, P1):
// the world-copy / sphere-routing predicates now DERIVE from these rows.
// These tests pin every table field — and the derived predicates — to their
// intended LITERAL value (not to their own derivation), so the table can
// never drift from real runtime behavior. (worldCopiesFor /
// enumerateWorldCopies / routeToSphereSelector are imported from gpu-shared
// to also exercise its re-export of the relocated predicates.)

describe('PROJECTIONS table', () => {
  it('is ordered so index === projType for every record', () => {
    PROJECTIONS.forEach((p, i) => expect(p.projType).toBe(i))
  })

  it('covers exactly the 8 known projections in wire order', () => {
    expect(PROJECTIONS.map((p) => p.name)).toEqual([
      'mercator', 'equirectangular', 'natural_earth', 'orthographic',
      'azimuthal_equidistant', 'stereographic', 'oblique_mercator', 'globe',
    ])
  })

  it('PROJECTION_NAME_TO_TYPE reproduces the prior render-loop literal map', () => {
    // Regression pin: the exact object that render-loop.ts hand-encoded
    // before deriving it from the table.
    expect(PROJECTION_NAME_TO_TYPE).toEqual({
      mercator: 0, equirectangular: 1, natural_earth: 2,
      orthographic: 3, azimuthal_equidistant: 4, stereographic: 5,
      oblique_mercator: 6, globe: 7,
    })
  })

  it('SELECTOR_PROJ_NAMES reproduces the prior VTR int→name array (globe excluded)', () => {
    expect(SELECTOR_PROJ_NAMES).toEqual([
      'mercator', 'equirectangular', 'natural_earth', 'orthographic',
      'azimuthal_equidistant', 'stereographic', 'oblique_mercator',
    ])
  })

  it('worldCopies === the ±2 multi-world set for the periodic family {0,1,2,6}, single otherwise', () => {
    const multiWorld = new Set([0, 1, 2, 6]) // mercator / equirect / NE / oblique
    for (const p of PROJECTIONS) {
      expect(p.worldCopies).toEqual(multiWorld.has(p.projType) ? [-2, -1, 0, 1, 2] : [0])
    }
  })

  it('worldCopiesFor() derives that set from the table (re-export pinned)', () => {
    for (const p of PROJECTIONS) {
      expect(worldCopiesFor(p.projType)).toEqual(p.worldCopies)
    }
  })

  it('periodic === the world-copy-enumerated set {1,2,6} (mercator is flat-routed)', () => {
    for (const p of PROJECTIONS) {
      expect(p.periodic).toBe([1, 2, 6].includes(p.projType))
    }
  })

  it('enumerateWorldCopies is gated above WORLD_COPY_MAX_ZOOM (off below the gate, on within)', () => {
    for (const p of PROJECTIONS) {
      expect(enumerateWorldCopies(p.projType, 4)).toBe(p.periodic) // z≤4: tracks periodic
      expect(enumerateWorldCopies(p.projType, 5)).toBe(false) // z>4: neighbours off-canvas
    }
  })

  it('routeToSphereSelector === {3,4,5,6} (derived !isFlat && !isGlobe), ∪ globeMode', () => {
    for (const p of PROJECTIONS) {
      expect(routeToSphereSelector(p.projType, false)).toBe([3, 4, 5, 6].includes(p.projType))
      expect(routeToSphereSelector(p.projType, true)).toBe(true) // globeMode forces sphere routing
    }
  })

  it('isCylindrical === multi-world (worldCopiesFor length > 1)', () => {
    for (const p of PROJECTIONS) {
      expect(p.isCylindrical).toBe(worldCopiesFor(p.projType).length > 1)
    }
  })

  it('isFlat === WGSL no-cull flat branch (projType ≤ 2)', () => {
    for (const p of PROJECTIONS) expect(p.isFlat).toBe(p.projType <= 2)
  })

  it('isSeam === antimeridian-seam set {1,2,6}', () => {
    for (const p of PROJECTIONS) {
      expect(p.isSeam).toBe([1, 2, 6].includes(p.projType))
    }
  })

  it('isGlobe === projType 7', () => {
    for (const p of PROJECTIONS) expect(p.isGlobe).toBe(p.projType === 7)
  })

  it('cull/rim thresholds match shaders/projection.ts per projType', () => {
    // ortho(3) + globe(7) cull at the visibility boundary (0.0);
    // azimuthal(4) at -0.85; stereographic(5) at -0.8; flat/cylindrical
    // (0,1,2,6) have no hemisphere cull. US-002 ties these literals to the
    // WGSL source via projection-threshold-drift.test.ts.
    const expected: Record<number, number | null> = {
      0: null, 1: null, 2: null, 3: 0.0, 4: -0.85, 5: -0.8, 6: null, 7: 0.0,
    }
    for (const p of PROJECTIONS) {
      expect(p.cullThreshold).toBe(expected[p.projType])
      expect(p.rimThreshold).toBe(expected[p.projType])
    }
  })
})
