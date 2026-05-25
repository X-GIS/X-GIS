import { describe, it, expect } from 'vitest'
import {
  PROJECTIONS,
  PROJECTION_NAME_TO_TYPE,
  SELECTOR_PROJ_NAMES,
} from './projections-table'
import { worldCopiesFor, enumerateWorldCopies } from '../gpu/gpu-shared'

// The PROJECTIONS table is the single source of truth, but the gpu-shared
// predicates remain the AUTHORITY for the capability fields. These tests
// pin every table field to its predicate (or to the exact prior literal
// for the canonical name↔int representations) so the table can never drift
// from real runtime behavior.

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

  it('worldCopies field === worldCopiesFor() predicate output', () => {
    for (const p of PROJECTIONS) {
      expect(p.worldCopies).toEqual(worldCopiesFor(p.projType))
    }
  })

  it('periodic field === enumerateWorldCopies() periodic set', () => {
    for (const p of PROJECTIONS) {
      // enumerateWorldCopies(pt, 0): zoom 0 ≤ WORLD_COPY_MAX_ZOOM, so the
      // result is exactly the `periodic` boolean.
      expect(p.periodic).toBe(enumerateWorldCopies(p.projType, 0))
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
