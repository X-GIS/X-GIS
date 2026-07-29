// #777 IV3 — the ground-basis PRODUCER: which labels get a basis, and when it is
// withheld.
//
// Everything downstream of `TextDraw.groundBasis` has been in place since #1462
// and is pinned elsewhere (text-ground-basis-wiring.test.ts drives the real
// renderer; ground-basis.test.ts pins the maths). This file pins the decision:
// the spec chain says WHICH labels lie in the ground plane, and the withheld
// cases are what keep "no basis ⇒ bit-identical to before IV3" true.
//
// The withheld cases matter more than the supplied one. A producer that handed
// out a basis too eagerly would tilt labels the spec says are billboards, and
// nothing downstream would object — the renderer applies whatever it is given.

import { describe, it, expect } from 'vitest'
import type { LabelDef } from '@xgis/compiler'
import { Camera } from '@xgis/map'
import { Pitch0Unprojector } from '../../camera/pitch0-unproject'
import { makeLabelProjectors } from '../../render-loop-helpers'
import { makeGroundBasisFor } from './dispatch-point-labels'
import { IDENTITY_BASIS } from '../../text/ground-basis'

const W = 800,
  H = 600,
  DPR = 1

/** A LabelDef carrying only what the producer reads. */
function def(over: Partial<LabelDef> = {}): LabelDef {
  return {
    text: { kind: 'literal', value: 'x' },
    size: 14,
    ...over,
  } as unknown as LabelDef
}

/** The REAL label projector, built from the same camera the basis composes
 *  against — the pairing label-pass makes. A hand-rolled stand-in would not
 *  exercise the thing the producer actually composes with. */
function projectorFor(cam: Camera): (lon: number, lat: number) => [number, number] | null {
  const view = cam.getViewForProjection(cam.projType, W, H, DPR)
  const { projectLonLat } = makeLabelProjectors(view.matrix, W, H, {
    projType: cam.projType,
    ccx: cam.centerX,
    ccy: cam.centerY,
    centerLon: 2.33194,
    centerLat: 48.84778,
    visibleWorldCopies: [0],
  })
  // Copy out of the projector's shared scratch before the next call.
  return (lon, lat) => {
    const p = projectLonLat(lon, lat)
    return p ? [p[0], p[1]] : null
  }
}

function pitchedCamera(pitch: number): Camera {
  const cam = new Camera(2.33194, 48.84778, 14)
  cam.pitch = pitch
  return cam
}

describe('#777 IV3 producer — the spec chain decides who gets a basis', () => {
  const cam = pitchedCamera(60)
  const make = (): ReturnType<typeof makeGroundBasisFor> =>
    makeGroundBasisFor(cam, W, H, projectorFor(cam), new Pitch0Unprojector())

  it('withholds one from a point label — the spec default is viewport', () => {
    // The measured reality this encodes: 25 symbol layers in bright.json, none
    // authoring text-pitch-alignment. A point label is a billboard unless asked.
    expect(make()(def({ placement: 'point' }), 400, 300, DPR)).toBeUndefined()
    expect(make()(def(), 400, 300, DPR)).toBeUndefined()
  })

  it('withholds one when either knob explicitly says viewport', () => {
    expect(
      make()(def({ placement: 'line', pitchAlignment: 'viewport' }), 400, 300, DPR),
    ).toBeUndefined()
    expect(
      make()(def({ placement: 'line', rotationAlignment: 'viewport' }), 400, 300, DPR),
    ).toBeUndefined()
  })

  it('offers one to a LINE-placed label with nothing authored — the default path', () => {
    // auto → text-rotation-alignment → map for line placement. This is the set
    // the user actually sees standing upright: road names, waterway names, shields.
    const basis = make()(def({ placement: 'line' }), 400, 300, DPR)
    expect(basis).toBeDefined()
    expect(basis!.every(Number.isFinite)).toBe(true)
  })

  it('offers one to a point label that authors pitch-alignment map', () => {
    expect(make()(def({ placement: 'point', pitchAlignment: 'map' }), 400, 300, DPR)).toBeDefined()
  })
})

describe('#777 IV3 producer — an unpitched camera supplies NOTHING', () => {
  it('withholds the identity rather than passing it through', () => {
    // The no-regression rung. At pitch 0 the basis is exactly [1,0,0,1] by
    // construction, so supplying it would be arithmetically a no-op — but it
    // would still walk the renderer's transform path. Omitting keeps the frame
    // provably bit-identical to before IV3, which is what #1442 established.
    const cam = pitchedCamera(0)
    const produce = makeGroundBasisFor(cam, W, H, projectorFor(cam), new Pitch0Unprojector())
    expect(produce(def({ placement: 'line' }), 400, 300, DPR)).toBeUndefined()
  })

  it('and the identity really is what the maths yields there (non-vacuity)', () => {
    // Without this, the test above would pass for a producer that returned
    // undefined for every camera — including a pitched one.
    expect(IDENTITY_BASIS).toEqual([1, 0, 0, 1])
    const cam = pitchedCamera(60)
    const produce = makeGroundBasisFor(cam, W, H, projectorFor(cam), new Pitch0Unprojector())
    expect(produce(def({ placement: 'line' }), 400, 300, DPR)).toBeDefined()
  })
})

describe('#777 IV3 producer — degenerate inputs withhold rather than corrupt', () => {
  it('withholds when the projector has no image for the anchor', () => {
    const cam = pitchedCamera(60)
    const produce = makeGroundBasisFor(cam, W, H, () => null, new Pitch0Unprojector())
    expect(produce(def({ placement: 'line' }), 400, 300, DPR)).toBeUndefined()
  })

  it('withholds under the azimuthal discs — no pitch-0 inverse there', () => {
    // `unprojectToLonLat` returns null for projType 3/4/5, so there is no basis to
    // build. The honest degradation is the billboard, NOT a per-projection
    // analytic fallback — see the note in text/ground-basis.ts.
    //
    // Those projections also read `pitch` as 0 (`pitchLocked` — a tilted 2D disc
    // is meaningless), so they are withheld twice over. Asserted through the real
    // camera rather than by forcing projType alone, which is why `pitchLocked` is
    // set here the way Map sets it.
    for (const projType of [3, 4, 5]) {
      const cam = pitchedCamera(60)
      cam.projType = projType
      cam.pitchLocked = true
      const produce = makeGroundBasisFor(cam, W, H, projectorFor(cam), new Pitch0Unprojector())
      expect(produce(def({ placement: 'line' }), 400, 300, DPR)).toBeUndefined()
    }
  })

  it('withholds on the globe — its unprojector has no lon/lat to give', () => {
    // Globe (projType 7) cannot go through the flat projector at all (label-pass
    // builds an ECEF one), so this pins the producer's actual gate: the pitch-0
    // unprojector returns null, so no basis exists regardless of the projector.
    const cam = pitchedCamera(60)
    cam.projType = 7
    cam.globeMode = true
    expect(new Pitch0Unprojector().unprojectToLonLat(cam, 400, 300, W, H, DPR)).toBeNull()
    const produce = makeGroundBasisFor(cam, W, H, () => [400, 300], new Pitch0Unprojector())
    expect(produce(def({ placement: 'line' }), 400, 300, DPR)).toBeUndefined()
  })

  it('withholds for a non-finite or zero font size rather than emitting NaN', () => {
    // probePx divides; a NaN basis would poison every vertex of the quad.
    const cam = pitchedCamera(60)
    const produce = makeGroundBasisFor(cam, W, H, projectorFor(cam), new Pitch0Unprojector())
    for (const size of [0, -3, NaN, Infinity]) {
      const b = produce(def({ placement: 'line', size } as Partial<LabelDef>), 400, 300, DPR)
      if (b !== undefined) expect(b.every(Number.isFinite)).toBe(true)
    }
  })
})
