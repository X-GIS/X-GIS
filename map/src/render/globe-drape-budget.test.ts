// ═══ #2094 — the globe fill drape's WHEN, as a pixel budget ═══
//
// The predicate this pins replaced a LOD CEILING, and the reason is a report:
// after #2093 landed, the owner saw the improvement on WebGL2 and NOT on WebGPU
// below z6, improving on zoom-in. That is exactly the two backends taking
// different paths — WebGL2 never bakes (`bakeAvailable` excludes it), so it has
// always rendered direct at every zoom, while WebGPU kept the bake under the
// ceiling. A level cannot express the question, so the gate now prices both paths
// in pixels: see globe-drape-budget.ts for the derivation and the measurements.
//
// Every row below is an anchor with a measurement or a standing gate behind it,
// not a number chosen to make the constant pass.

import { describe, it, expect } from 'vitest'
import { tileSegmentAngleRad } from '@xgis/compiler'
import { TILE_PX } from '@xgis/geo'
import {
  GLOBE_DRAPE_CHORD_BUDGET_PX,
  directChordErrorPx,
  drapesAtChordBudget,
} from './globe-drape-budget'

/** Independent restatement of the closed form, so a typo in the module is not
 *  simply mirrored here: err = R_px·(1 − cos(θ/2)), R_px = TILE_PX·2^Z/2π. */
function expectedErr(drawnZ: number, cameraZoom: number): number {
  const rPx = (TILE_PX * 2 ** cameraZoom) / (2 * Math.PI)
  return rPx * (1 - Math.cos(tileSegmentAngleRad(drawnZ) / 2))
}

describe('#2094 globe drape budget — the gate is a pixel error, not a level', () => {
  it('EVERY native zoom renders direct — the defect the level ceiling could not express', () => {
    // The owner's report: z0-z5 stayed blurry on WebGPU while WebGL2 looked right.
    // At native zoom the drawn level IS the camera's, on any source, and the direct
    // arm's chord error peaks at 1.57 px (z8, where a tile edge has just fallen
    // under the tiler's absolute 2-degree gate and stops being split — #2435).
    for (let z = 0; z <= 22; z++) {
      const err = directChordErrorPx(z, z)
      expect({ z, drapes: drapesAtChordBudget(z, z), over: err > 2 }).toEqual({
        z,
        drapes: false,
        over: false,
      })
    }
  })

  it('the same DRAWN level drapes or not depending only on the camera — a level cannot do this', () => {
    // z14 tiles: direct at the camera that can be served, draped once the camera has
    // run far past them. This is the property the whole change exists for.
    expect(drapesAtChordBudget(14, 14)).toBe(false)
    expect(drapesAtChordBudget(14, 18)).toBe(false)
    expect(drapesAtChordBudget(14, 22)).toBe(true)
  })

  it('keeps the two cameras measured direct-better on the direct arm (#2094)', () => {
    // OFM Positron, dpr 2, SwiftShader, drape vs direct vs a Mercator control:
    //   z18.0  Δz 4.0  D1 41.68 % < D0 44.28 %          — direct closer to Mercator
    //   z21.1  Δz 7.1  scalars tie at ~9 %, and the FRAMES break it: the drape draws
    //                  the road with a kinked, wobbling outline where the direct arm
    //                  and the control both draw a clean straight band.
    expect(directChordErrorPx(14, 18)).toBeCloseTo(0.393, 2)
    expect(drapesAtChordBudget(14, 18)).toBe(false)
    expect(directChordErrorPx(14, 21.1)).toBeCloseTo(3.367, 2)
    expect(drapesAtChordBudget(14, 21.1)).toBe(false)
    // ...so the budget must sit just ABOVE the deepest camera direct was measured to
    // win at. A budget at or under 3.37 would send z21.1 back to the bake.
    expect(GLOBE_DRAPE_CHORD_BUDGET_PX).toBeGreaterThan(directChordErrorPx(14, 21.1))
  })

  it('keeps the shallow sources the design records as load-bearing on the DRAPE', () => {
    // `_globe-drape-overzoom-gate` drives the maxzoom-2 mirror at z10.3 and asserts
    // the #2024 windowed overzoom is live there; the engine's synthetic
    // earth-surface / polar-cap sources are maxLevel 0. Both must still drape, and
    // both are an order of magnitude past the budget — the upper anchor.
    expect(directChordErrorPx(2, 10.3)).toBeGreaterThan(25)
    expect(drapesAtChordBudget(2, 10.3)).toBe(true)
    expect(drapesAtChordBudget(0, 6)).toBe(true)
    expect(GLOBE_DRAPE_CHORD_BUDGET_PX).toBeLessThan(directChordErrorPx(0, 6))
  })

  it('is monotonic in the camera and reads the closed form the header quotes', () => {
    for (const z of [0, 2, 6, 8, 14]) {
      for (let Z = z; Z <= z + 8; Z += 0.5) {
        expect(directChordErrorPx(z, Z)).toBeCloseTo(expectedErr(z, Z), 9)
      }
      // R_px doubles per level of camera zoom and theta is fixed per tile level,
      // so the error doubles too — the property that makes the delta the thing
      // being priced.
      expect(directChordErrorPx(z, z + 1) / directChordErrorPx(z, z)).toBeCloseTo(2, 6)
    }
    // Zooming OUT never drapes something that was direct.
    expect(drapesAtChordBudget(9, 3)).toBe(false)
  })
})

describe('#2435 — the tiler rule this budget reads, and its z8 peak', () => {
  it('stops shrinking where a tile edge falls under the absolute 2-degree gate', () => {
    // The segment angle is the tiler's, not the renderer's: it halves per level
    // while the edge is over the gate, then STOPS. That is why the direct path's
    // native-zoom error peaks at z8 instead of falling monotonically, and it is
    // what #2435 fixes with a per-tile-level granularity.
    const deg = (r: number) => (r * 180) / Math.PI
    expect(deg(tileSegmentAngleRad(8))).toBeCloseTo(1.40625, 4)
    expect(deg(tileSegmentAngleRad(9))).toBeCloseTo(0.703125, 4)
    // z6 and z7 are SPLIT down to the same 1.40625 deg, so their error differs only
    // by the camera scale — the sawtooth.
    expect(deg(tileSegmentAngleRad(6))).toBeCloseTo(1.40625, 4)
    expect(deg(tileSegmentAngleRad(7))).toBeCloseTo(1.40625, 4)
    const native = [6, 7, 8, 9, 10].map((z) => directChordErrorPx(z, z))
    expect(native[2]).toBeGreaterThan(native[1]) // z8 worse than z7
    expect(native[2]).toBeGreaterThan(native[3]) // and worse than z9
    // The depth cap owns the other end: z0's 360 deg span cannot reach 2 deg in
    // MAX_TRI_SUBDIVIDE_DEPTH bisections, so it stops at 360/32.
    expect(deg(tileSegmentAngleRad(0))).toBeCloseTo(11.25, 6)
  })
})
