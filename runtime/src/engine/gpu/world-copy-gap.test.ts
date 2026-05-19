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

  it('Equirectangular (1): world-copy enumeration (iter 123)', () => {
    // wrap_lon_delta keeps each vertex in its own world strip; camera
    // offset shifts the strip on screen exactly like Mercator. The
    // pseudocyl pair (equirect / NE) now matches the camera-shift
    // mechanism Mercator + Oblique Mercator already use.
    const copies = worldCopiesFor(1)
    expect(copies.length).toBeGreaterThan(1)
    expect(copies).toEqual([-2, -1, 0, 1, 2])
  })

  it('Natural Earth (2): world-copy enumeration (iter 123)', () => {
    // Same model as Equirectangular — pseudocyl x is still linear in
    // lon_rel (scaled by lat-dependent x_scale), so camera offset
    // translates the rendered strip cleanly.
    const copies = worldCopiesFor(2)
    expect(copies.length).toBeGreaterThan(1)
    expect(copies).toEqual([-2, -1, 0, 1, 2])
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

  it('Oblique Mercator (6): world-copy enumeration (rotated cylindrical wraps after 2π — iter 122)', () => {
    // Same WORLD_COPIES enumeration as Mercator. Vertex shader applies
    // the camera offset in projected meters; lam_rot wraps cleanly so
    // ±WORLD_MERC shifts produce valid adjacent worlds across the
    // antimeridian of the rotated frame.
    const copies = worldCopiesFor(6)
    expect(copies.length).toBeGreaterThan(1)
    expect(copies).toEqual([-2, -1, 0, 1, 2])
  })

  it('Globe (7): single-world (3D sphere, not applicable)', () => {
    const copies = worldCopiesFor(7)
    expect(copies.length).toBe(1)
  })

  it('cylindrical + pseudocyl projections return multi-world; rest single-world', () => {
    let multi = 0
    for (let t = 0; t <= 7; t++) {
      if (worldCopiesFor(t).length > 1) multi++
    }
    // Iter 123: Mercator (0) + Equirect (1) + NE (2) + Oblique Merc (6).
    // Globe (7) renders a true sphere; Ortho/Azimuth/Stereo (3-5) clip
    // to a disc — all single-world.
    expect(multi).toBe(4)
  })
})
