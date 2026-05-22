// World-copy support inventory. Pin which projections enumerate
// multiple world copies vs single-world.
//
// Cylindrical / pseudocylindrical projections (Mercator, Equirect,
// Natural Earth, Oblique Mercator) are 2π-periodic in lon, so
// features at lon ± 360 render as visually distinct copies and the
// pyramid enumerates 5 copies (-2..+2). Hemispherical projections
// (Ortho, Azimuthal, Stereographic) and the 3D Globe stay single-
// world because no periodicity exists.
//
// Plan §5.2 closed: iter 126 (`965c6c3`) flipped projType 1+2 to
// WORLD_COPIES (z=0 root-split per worldCopy + project_geom wo
// offset). Iter 127 (`0df48ec`) added oblique-mercator (projType 6).
// E2E `_world-copy-projections.spec.ts` pins the rendered behaviour.

import { describe, expect, it } from 'vitest'
import { worldCopiesFor, enumerateWorldCopies, WORLD_COPY_MAX_ZOOM } from './gpu-shared'

describe('worldCopiesFor — projection world-copy enumeration', () => {
  it('Mercator (0): returns 5 copies (-2..+2)', () => {
    const copies = worldCopiesFor(0)
    expect(copies.length).toBe(5)
    expect(Array.from(copies)).toEqual([-2, -1, 0, 1, 2])
  })

  it('Equirectangular (1): world-copy enumeration (iter 126)', () => {
    const copies = worldCopiesFor(1)
    expect(copies.length).toBe(5)
    expect(Array.from(copies)).toEqual([-2, -1, 0, 1, 2])
  })

  it('Natural Earth (2): world-copy enumeration (iter 126)', () => {
    const copies = worldCopiesFor(2)
    expect(copies.length).toBe(5)
    expect(Array.from(copies)).toEqual([-2, -1, 0, 1, 2])
  })

  it('Orthographic (3): single-world (hemispherical, not applicable)', () => {
    const copies = worldCopiesFor(3)
    expect(copies.length).toBe(1)
  })

  it('Azimuthal (4): single-world (hemispherical)', () => {
    const copies = worldCopiesFor(4)
    expect(copies.length).toBe(1)
  })

  it('Stereographic (5): single-world (hemispherical)', () => {
    const copies = worldCopiesFor(5)
    expect(copies.length).toBe(1)
  })

  it('Oblique Mercator (6): world-copy enumeration (iter 127)', () => {
    // Rotated lon wraps after 2π just like Mercator's lon. World-copy
    // works after iter 127 globeVisibleTiles WORLD_COPIES enumeration
    // + project_geom wo-offset for the oblique branch.
    const copies = worldCopiesFor(6)
    expect(copies.length).toBe(5)
    expect(Array.from(copies)).toEqual([-2, -1, 0, 1, 2])
  })

  it('Globe (7): single-world (3D sphere, not applicable)', () => {
    const copies = worldCopiesFor(7)
    expect(copies.length).toBe(1)
  })

  it('only one projType currently returns multiple world copies', () => {
    let multi = 0
    for (let t = 0; t <= 7; t++) {
      if (worldCopiesFor(t).length > 1) multi++
    }
    // Iter 127: Mercator (0) + Equirect (1) + NE (2) + Oblique Merc (6).
    // All cylindrical / pseudocyl projections enumerate world copies.
    expect(multi).toBe(4)
  })
})

describe('enumerateWorldCopies — iter 139 low-zoom gate (user-bug pin)', () => {
  // 2026-05-19: equirect/NE/oblique suffered 5× tile jank at Seoul
  // street zoom because iter 127 enumerated ±2 world copies at EVERY
  // zoom. iter 139 gates to z<=WORLD_COPY_MAX_ZOOM. These cases lock
  // the predicate so the regression can't silently return.
  const PERIODIC = [1, 2, 6]   // equirect, natural_earth, oblique-merc
  const NON_PERIODIC = [0, 3, 4, 5, 7] // merc(SSE path), ortho, azi, stereo, globe

  it('periodic projections enumerate copies at/below the zoom gate', () => {
    for (const p of PERIODIC) {
      expect(enumerateWorldCopies(p, 0)).toBe(true)
      expect(enumerateWorldCopies(p, WORLD_COPY_MAX_ZOOM)).toBe(true)
    }
  })

  it('periodic projections do NOT enumerate copies above the gate', () => {
    for (const p of PERIODIC) {
      // The exact street-zoom range the user reported jank at.
      expect(enumerateWorldCopies(p, WORLD_COPY_MAX_ZOOM + 0.01)).toBe(false)
      expect(enumerateWorldCopies(p, 11.5)).toBe(false)
      expect(enumerateWorldCopies(p, 16)).toBe(false)
    }
  })

  it('non-periodic projections never enumerate copies (any zoom)', () => {
    for (const p of NON_PERIODIC) {
      for (const z of [0, 2, 4, 8, 15]) {
        expect(enumerateWorldCopies(p, z)).toBe(false)
      }
    }
  })
})

// iter-322 — cross-consistency between the TWO world-copy functions.
// `worldCopiesFor` (which copy coords to emit) and `enumerateWorldCopies`
// (whether the globeVisibleTiles-routed path wraps at this zoom) encode
// the SAME periodicity fact independently. If a future edit adds a
// projType to one list but not the other, the renderer either emits
// copy coords nobody draws OR tries to wrap a projection with only a
// single world. These pins force the two to agree.
describe('iter-322 worldCopiesFor ↔ enumerateWorldCopies cross-consistency', () => {
  const ALL_PROJ = [0, 1, 2, 3, 4, 5, 6, 7]

  it('every projType where copies CAN be enumerated has >1 world copy', () => {
    // enumerateWorldCopies(p, lowZoom)===true  ⟹  worldCopiesFor(p).length>1.
    // Otherwise the wrap walk finds no neighbour coords to emit.
    for (const p of ALL_PROJ) {
      if (enumerateWorldCopies(p, 0)) {
        expect(worldCopiesFor(p).length, `proj ${p} enumerates but is single-world`).toBeGreaterThan(1)
      }
    }
  })

  it('the only multi-copy projType that never enumerates is mercator (frustum path)', () => {
    // Mercator (0) has 5 copies but enumerateWorldCopies(0)===false because
    // its frustum selector emits world copies inline (not via the gate).
    // Any OTHER multi-copy projType MUST enumerate at low zoom.
    for (const p of ALL_PROJ) {
      const multi = worldCopiesFor(p).length > 1
      const enumerates = enumerateWorldCopies(p, 0)
      if (multi && !enumerates) {
        expect(p, `proj ${p}: multi-copy but never enumerates — only mercator may`).toBe(0)
      }
    }
  })

  it('all 8 projTypes resolve to a defined, non-empty copy set', () => {
    for (const p of ALL_PROJ) {
      const copies = worldCopiesFor(p)
      expect(copies, `proj ${p} undefined copy set`).toBeDefined()
      expect(copies.length, `proj ${p} empty copy set`).toBeGreaterThanOrEqual(1)
      // Copy 0 (the home world) MUST always be present.
      expect(copies.includes(0), `proj ${p} missing home world copy 0`).toBe(true)
    }
  })

  it('unknown projType (out-of-range) collapses to single-world (no crash)', () => {
    // Defensive: a corrupt proj_params.x must not blow up enumeration.
    for (const bad of [-1, 8, 99, NaN]) {
      expect(worldCopiesFor(bad)).toEqual([0])
      expect(enumerateWorldCopies(bad, 0)).toBe(false)
    }
  })
})
