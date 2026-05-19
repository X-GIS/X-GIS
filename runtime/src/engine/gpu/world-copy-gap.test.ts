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
import { worldCopiesFor } from './gpu-shared'

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
