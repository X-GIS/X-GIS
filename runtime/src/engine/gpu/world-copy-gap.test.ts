// World-copy support inventory. Pin the current state of which
// projections enumerate multiple world copies vs single-world.
// Mercator gets 5 copies — its periodicity in lon means features
// at lon ± 360 are visually distinct copies. Other projections
// currently return SINGLE_WORLD even when they SHOULD repeat
// (equirect / natural_earth at low zoom show black edges at the
// world boundary instead of wrapping).
//
// Plan §5.2 followup: equirect / natural_earth (projType 1, 2)
// should return WORLD_COPIES once the WGSL vertex shader applies
// a per-instance world-x offset. Until then this test pins the
// current SINGLE_WORLD state so a partial fix that flips one but
// not the other doesn't silently regress.

import { describe, expect, it } from 'vitest'
import { worldCopiesFor } from './gpu-shared'

describe('worldCopiesFor — current world-copy enumeration state', () => {
  it('Mercator (0): returns 5 copies (-2..+2)', () => {
    const copies = worldCopiesFor(0)
    expect(copies.length).toBe(5)
    expect(Array.from(copies)).toEqual([-2, -1, 0, 1, 2])
  })

  it('Equirectangular (1): currently single-world (plan §5.2 gap)', () => {
    const copies = worldCopiesFor(1)
    expect(copies.length).toBe(1)
    expect(Array.from(copies)).toEqual([0])
  })

  it('Natural Earth (2): currently single-world (plan §5.2 gap)', () => {
    const copies = worldCopiesFor(2)
    expect(copies.length).toBe(1)
    expect(Array.from(copies)).toEqual([0])
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

  it('Oblique Mercator (6): single-world (rotated cylindrical, not applicable)', () => {
    const copies = worldCopiesFor(6)
    expect(copies.length).toBe(1)
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
    // Pre-§5.2: 1. Post-§5.2 fix: 3 (Mercator + Equirect + NE).
    // Pin at 1 so the partial fix that flips equirect WITHOUT WGSL
    // support visibly breaks this gate.
    expect(multi).toBe(1)
  })
})
