// ADR-0012 D1 / INC-1 — the ground-basis PRODUCER: which labels get a basis,
// when it is withheld, and what it must not disturb while deriving one.
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
//
// Two INC-1 additions, and both exist because the failure they guard is SILENT:
//
//  - NEEDS-PROBE 1 — the far field. A pitched frame's far band is far outside
//    the UNPITCHED frame, so a pitch-0 projector carrying the label pass's
//    NDC ±1.5 viewport cull returns null for exactly the labels ground
//    projection is most visible on. The near field would keep working, so the
//    symptom reads as "the basis is subtle", not as "the basis is missing".
//  - Q7 (basis half) — the frame projector's shared out-state. The world-anchored
//    phase lattice (#1358) measures its origin against the SAME projector family
//    the anchors came from (`mercOffsetToScreenOffset` over the live screen
//    arrays, label-pass.ts). If deriving a basis moved that projector's scratch
//    or its perspective-scale out-value, the phase origin and the walk would
//    disagree under pitch. The producer must therefore be side-effect-free on it.

import { describe, it, expect } from 'vitest'
import type { LabelDef } from '@xgis/compiler'
import { Camera } from '@xgis/map'
import { Pitch0Unprojector, type FlatGroundView } from '../../camera/pitch0-unproject'
import { makeLabelProjectors } from '../../render-loop-helpers'
import { dispatchPointLabel, makeGroundBasisFor } from './dispatch-point-labels'
import { IDENTITY_BASIS } from '../../text/ground-basis'

const W = 800,
  H = 600,
  DPR = 1
const CENTER_LON = 2.33194,
  CENTER_LAT = 48.84778

/** A LabelDef carrying only what the producer reads. */
function def(over: Partial<LabelDef> = {}): LabelDef {
  return {
    text: { kind: 'literal', value: 'x' },
    size: 14,
    ...over,
  } as unknown as LabelDef
}

function flatFor(cam: Camera): FlatGroundView {
  return {
    projType: cam.projType,
    ccx: cam.centerX,
    ccy: cam.centerY,
    centerLon: CENTER_LON,
    centerLat: CENTER_LAT,
  }
}

/** The producer as `label-pass` builds it: this frame's matrix, its pitch-0
 *  twin, and the same projection constants the anchors were placed with. */
function producerFor(
  cam: Camera,
  flat: FlatGroundView | undefined = flatFor(cam),
): ReturnType<typeof makeGroundBasisFor> {
  return makeGroundBasisFor(
    cam,
    cam.getViewForProjection(cam.projType, W, H, DPR).matrix,
    new Pitch0Unprojector().matrix(cam, W, H, DPR),
    W,
    H,
    flat,
  )
}

function pitchedCamera(pitch: number): Camera {
  const cam = new Camera(CENTER_LON, CENTER_LAT, 14)
  cam.pitch = pitch
  return cam
}

describe('D1 INC-1 producer — the spec chain decides who gets a basis', () => {
  const cam = pitchedCamera(60)
  const at: [number, number] = [CENTER_LON + 0.004, CENTER_LAT + 0.003]

  it('withholds one from a point label — the spec default is viewport', () => {
    // The measured reality this encodes: 25 symbol layers in bright.json, none
    // authoring text-pitch-alignment. A point label is a billboard unless asked.
    expect(producerFor(cam)(def({ placement: 'point' }), ...at)).toBeUndefined()
    expect(producerFor(cam)(def(), ...at)).toBeUndefined()
  })

  it('withholds one when either knob explicitly says viewport', () => {
    expect(
      producerFor(cam)(def({ placement: 'line', pitchAlignment: 'viewport' }), ...at),
    ).toBeUndefined()
    expect(
      producerFor(cam)(def({ placement: 'line', rotationAlignment: 'viewport' }), ...at),
    ).toBeUndefined()
  })

  it('offers one to a LINE-placed label with nothing authored — the default path', () => {
    // auto → text-rotation-alignment → map for line placement. This is the set
    // the user actually sees standing upright: road names, waterway names, shields.
    const basis = producerFor(cam)(def({ placement: 'line' }), ...at)
    expect(basis).toBeDefined()
    expect(basis!.every(Number.isFinite)).toBe(true)
  })

  it('offers one to a point label that authors pitch-alignment map', () => {
    expect(
      producerFor(cam)(def({ placement: 'point', pitchAlignment: 'map' }), ...at),
    ).toBeDefined()
  })
})

describe('D1 INC-1 producer — an unpitched camera supplies NOTHING', () => {
  const at: [number, number] = [CENTER_LON + 0.004, CENTER_LAT + 0.003]

  it('withholds the identity rather than passing it through', () => {
    // The no-regression rung. At pitch 0 the basis is exactly [1,0,0,1] by
    // construction, so supplying it would be arithmetically a no-op — but it
    // would still walk the renderer's transform path. Omitting keeps the frame
    // provably bit-identical to before IV3, which is what #1442 established.
    expect(producerFor(pitchedCamera(0))(def({ placement: 'line' }), ...at)).toBeUndefined()
  })

  it('and the identity really is what the maths yields there (non-vacuity)', () => {
    // Without this, the test above would pass for a producer that returned
    // undefined for every camera — including a pitched one.
    expect(IDENTITY_BASIS).toEqual([1, 0, 0, 1])
    expect(producerFor(pitchedCamera(60))(def({ placement: 'line' }), ...at)).toBeDefined()
  })
})

// NEEDS-PROBE 1. Measured on this exact camera family before the construction was
// written: with the viewport cull left ON, a pitch-0 projector rejected 0 % of
// on-screen anchors at pitch 30, 12.2 % at 45, 24.4 % at 60 and 36.6 % at 70 —
// all of them in the top band of the frame. The gate below walks the frame from
// the far edge to the near one and requires a basis at EVERY on-screen anchor, so
// re-introducing any viewport cull on either projector fails it and the failure
// names the row it started at.
describe('D1 INC-1 producer — the far field is where the basis must NOT go missing', () => {
  for (const pitch of [45, 60, 70]) {
    it(`every on-screen anchor gets a basis at pitch ${pitch}`, () => {
      const cam = pitchedCamera(pitch)
      const produce = producerFor(cam)
      const { projectLonLat } = makeLabelProjectors(
        cam.getViewForProjection(cam.projType, W, H, DPR).matrix,
        W,
        H,
        { ...flatFor(cam), visibleWorldCopies: [0] },
      )
      const d = def({ placement: 'line' })
      const missing: string[] = []
      let anchors = 0
      let farField = 0
      for (let sy = 0; sy <= H; sy += 20) {
        for (let sx = 0; sx <= W; sx += 40) {
          const ll = cam.unprojectToLonLat(sx, sy, W, H, DPR)
          if (!ll || !projectLonLat(ll[0], ll[1])) continue
          anchors++
          if (sy < H / 2) farField++
          if (produce(d, ll[0], ll[1]) === undefined) missing.push(`(${sx},${sy})`)
        }
      }
      // Non-vacuity in both directions: the lattice must actually have found
      // on-screen anchors, and a real share of them must be ABOVE the centre
      // row — the band the pitch-0 image pushes outside the unpitched frame.
      expect(anchors, 'the lattice found no on-screen anchors').toBeGreaterThan(200)
      expect(farField, 'the lattice never reached the far half of the frame').toBeGreaterThan(100)
      expect(
        missing,
        `${missing.length}/${anchors} on-screen anchors got NO basis at pitch ${pitch}, first at ` +
          `${missing[0]} — a viewport cull is back on one of the basis projectors, and it drops ` +
          `the far field (NEEDS-PROBE 1: 24.4 % of the frame at pitch 60) while the near field ` +
          `keeps working, so the symptom reads as a subtle basis rather than a missing one`,
      ).toEqual([])
    })
  }

  it('and the far field is genuinely MORE foreshortened than the centre (non-vacuity)', () => {
    // Without this, the sweep above would pass for a producer that returned a
    // constant basis everywhere. det falls monotonically toward the horizon.
    const cam = pitchedCamera(60)
    const produce = producerFor(cam)
    const d = def({ placement: 'line' })
    let prev = Infinity
    for (const sy of [H / 2, H / 2 - 100, H / 2 - 200, H / 2 - 300]) {
      const ll = cam.unprojectToLonLat(W / 2, sy, W, H, DPR)!
      const b = produce(d, ll[0], ll[1])!
      const det = b[0] * b[3] - b[1] * b[2]
      expect(det, `sy=${sy}`).toBeLessThan(prev)
      prev = det
    }
  })
})

// Q7, basis half. The full form of the question — does the world-anchored phase
// lattice (#1358) survive the label-plane walk — belongs to INC-4, which moves
// that walk. What INC-1 owes is the premise the whole question rests on: the
// basis replacement must leave every OTHER quantity the wired dispatch site
// emits exactly where it was, because the phase origin, the anchors and the
// paired icon are all measured against the frame projector's shared out-state.
//
// Driven through `dispatchPointLabel` itself, against the REAL projector family,
// at the whole-world zoom where the anchor genuinely fans out into more than one
// world copy — the arrangement where the hazard is live: the dispatch loop
// iterates `projectLonLatCopies`' array WHILE calling the basis producer, so a
// producer that reached back into that projector would leave `perspectiveScale()`
// holding one of its own probes instead of the anchor's, under the paired icon.
//
// CUT 1 at the bottom is what stops these assertions from being vacuous. The
// shipped signature makes the coupling unreachable — `makeGroundBasisFor` is
// never handed the frame projector — so the cut models the shape the pre-INC-1
// producer had (its probes went through the frame's own `projectLonLat`) and
// asserts the comparisons above notice it.
describe('D1 INC-1 — the basis replacement moves nothing else at the wired site', () => {
  const AT: [number, number] = [CENTER_LON + 0.004, CENTER_LAT + 0.003]

  /** The frame's projector family, wired as `label-pass` wires it, at a zoom
   *  where the world repeats so the anchor really has several copies. */
  function frame(): { cam: Camera; projectors: ReturnType<typeof makeLabelProjectors> } {
    const cam = new Camera(CENTER_LON, CENTER_LAT, 0)
    cam.pitch = 60
    return {
      cam,
      projectors: makeLabelProjectors(
        cam.getViewForProjection(cam.projType, W, H, DPR).matrix,
        W,
        H,
        { ...flatFor(cam), visibleWorldCopies: [-1, 0, 1] },
      ),
    }
  }

  interface Emitted {
    anchors: Array<[number, number, number | undefined]>
    icons: Array<[number, number, number | undefined]>
    bases: Array<number[] | undefined>
    psAfter: number
  }

  /** One dispatch through the real projector family. The producer is built FROM
   *  that frame's own projectors, so a cut below can couple to the very instance
   *  the dispatch loop is reading — coupling to a different instance would prove
   *  nothing, which is the trap this signature exists to close. */
  function run(
    makeProducer: (
      projectors: ReturnType<typeof makeLabelProjectors>,
      cam: Camera,
    ) => ReturnType<typeof makeGroundBasisFor>,
  ): Emitted {
    const { cam, projectors } = frame()
    const out: Emitted = { anchors: [], icons: [], bases: [], psAfter: 0 }
    dispatchPointLabel({ type: 'Point' }, {}, ...AT, {
      applyFeatureExprs: () => def({ placement: 'line' }),
      projectLonLatCopies: projectors.projectLonLatCopies,
      addLabel: (_v, _p, x, y, _d, _f, _ln, _pk, _cid, ps, basis) => {
        out.anchors.push([x, y, ps])
        out.bases.push(basis ? Array.from(basis) : undefined)
      },
      dispatchIcon: (_d, x, y, _t, _pk, _c, _props, ps) => out.icons.push([x, y, ps]),
      layerName: 'probe',
      nextPairKey: () => 'k',
      groundBasisFor: makeProducer(projectors, cam),
    })
    out.psAfter = projectors.perspectiveScale()
    return out
  }

  const NO_BASIS = () => () => undefined

  it('emits the same anchors, perspective scales and copy count as a basis-free run', () => {
    const withBasis = run((_p, cam) => producerFor(cam))
    const without = run(NO_BASIS)

    expect(
      withBasis.anchors.length,
      'the probe anchor produced fewer than 2 world copies — the multi-copy case this gate ' +
        'exists for was never exercised',
    ).toBeGreaterThan(1)
    expect(
      withBasis.anchors,
      'the basis derivation moved the label anchors or their perspective scales — the ' +
        'quantities the #1358 phase origin and the placement are measured from',
    ).toEqual(without.anchors)
    expect(
      withBasis.icons,
      'the basis derivation moved the paired icon anchors or their perspective scales',
    ).toEqual(without.icons)
    expect(
      withBasis.psAfter,
      "the frame projector's perspectiveScale() out-value was left holding a BASIS probe " +
        "rather than the last anchor's",
    ).toBe(without.psAfter)
  })

  it('and every world copy carries the SAME basis — one ground point, seen N times', () => {
    // Consequence of deriving at the ground point rather than at a screen anchor.
    // Pinned so a later change cannot silently make it per-copy again, which is
    // what a re-introduced screen-anchor dependency would do.
    const { bases } = run((_p, cam) => producerFor(cam))
    expect(bases[0], 'no basis reached addLabel — the assertion below is vacuous').toBeDefined()
    for (const b of bases) expect(b).toEqual(bases[0])
  })

  it('CUT 1: a producer that PROBES the frame projector moves perspectiveScale()', () => {
    // The pre-INC-1 shape: projections through the frame's OWN `projectLonLat`,
    // which writes the shared perspScale out-value. The probe is deliberately far
    // north — the axis a pitched camera attenuates along — so its attenuation
    // differs from the anchor's unmistakably (0.970 vs 0.99999 here). A probe
    // beside the anchor is indistinguishable at this camera and would let the cut
    // pass while proving nothing, which is the failure this whole block guards.
    const coupled = run((projectors) => (_d, lon, lat) => {
      projectors.projectLonLat(lon + 1, lat)
      projectors.projectLonLat(lon, lat + 20)
      return [1, 0, 0, 0.5]
    })
    expect(
      coupled.psAfter,
      'a producer probing the frame projector left perspectiveScale() untouched, so the ' +
        'assertion above cannot tell a coupled producer from an independent one',
    ).not.toBe(run(NO_BASIS).psAfter)
  })
})

/** The producer as `label-pass` builds it on the GLOBE path: no `flat` at all,
 *  because the ECEF projector is a different family. Spelled out rather than
 *  routed through `producerFor(cam, undefined)`, which a default parameter would
 *  silently turn back into the flat args. */
function globeProducerFor(cam: Camera): ReturnType<typeof makeGroundBasisFor> {
  return makeGroundBasisFor(
    cam,
    cam.getViewForProjection(cam.projType, W, H, DPR).matrix,
    new Pitch0Unprojector().matrix(cam, W, H, DPR),
    W,
    H,
    undefined,
  )
}

describe('D1 INC-1 producer — degenerate inputs withhold rather than corrupt', () => {
  const at: [number, number] = [CENTER_LON + 0.004, CENTER_LAT + 0.003]

  it('withholds on the globe — projType 7 has no map plane, and no flat args', () => {
    // The globe renders through the ECEF projector, so `label-pass` has no `flat`
    // to hand over and the producer withholds before building anything. Deferred
    // with its reason in §3.2 of docs/plans/2026-08-24-label-ground-projection.md;
    // the label billboards exactly as it does today. Withholding EARLY also keeps
    // the flat CPU forward off a projType it throws on.
    const cam = pitchedCamera(60)
    cam.projType = 7
    cam.globeMode = true
    expect(globeProducerFor(cam)(def({ placement: 'line' }), ...at)).toBeUndefined()
  })

  it('withholds where the pitch-0 step degenerates — the Mercator pole clamp', () => {
    // A label pinned past ±85.051129 has both its latitude probes clamped to the
    // same Mercator y, so the pitch-0 Jacobian is singular and the solve has no
    // answer. That is the one reachable degeneracy on the flat path, and the
    // honest response is the billboard, not an infinite north axis.
    const cam = pitchedCamera(60)
    const produce = producerFor(cam)
    expect(produce(def({ placement: 'line' }), CENTER_LON, 85.6)).toBeUndefined()
    expect(produce(def({ placement: 'line' }), CENTER_LON, -85.6)).toBeUndefined()
  })

  it('withholds for a non-finite or zero font size rather than emitting NaN', () => {
    // The size no longer feeds the probe radius (that was `probePxFor`, retired
    // with the screen-anchor construction), but a malformed def must still never
    // reach the renderer as NaN vertices.
    const cam = pitchedCamera(60)
    const produce = producerFor(cam)
    for (const size of [0, -3, NaN, Infinity]) {
      const b = produce(def({ placement: 'line', size } as Partial<LabelDef>), ...at)
      if (b !== undefined) expect(b.every(Number.isFinite)).toBe(true)
    }
  })
})

describe('D1 INC-1 producer — the azimuthal discs are reachable now, and only at pitch', () => {
  // The predecessor could not produce a basis for projType 3/4/5 AT ALL:
  // `unprojectToLonLat` returns null there, so the composition had no ground
  // point to start from. The forward-only ratio needs no inverse. What still
  // withholds is the camera's own pitch — a disc that is genuinely unpitched has
  // an identity basis — so both halves are asserted, or the claim is untestable.
  //
  // Driven at the whole-world zoom the discs are actually used at, and a degree
  // off centre rather than a few metres. That is not cosmetic: `projGeom` for
  // azimuthal_equidistant (projType 4) returns EXACTLY the projection centre for
  // every point within ~0.05° of it — `acos(cos_c)` collapses once `cos_c` rounds
  // to 1 — so a near-centre probe measures that pre-existing dead zone instead of
  // this construction. It predates INC-1 and is reported, not fixed here.
  const at: [number, number] = [CENTER_LON + 1.7, CENTER_LAT + 1.3]

  function discCamera(projType: number, pitch: number): Camera {
    const cam = new Camera(CENTER_LON, CENTER_LAT, 2)
    cam.projType = projType
    cam.pitch = pitch
    return cam
  }

  for (const projType of [3, 4, 5]) {
    it(`projType ${projType}: a basis under pitch, none at pitch 0`, () => {
      const b = producerFor(discCamera(projType, 60))(def({ placement: 'line' }), ...at)
      expect(b, `no basis for projType ${projType} — the disc is out of scope again`).toBeDefined()
      expect(b!.every(Number.isFinite)).toBe(true)
      // Non-vacuity: a real tilt, not a rounding-noise basis that slipped past
      // `isIdentityBasis`.
      expect(b![3]).toBeLessThan(0.9)
      expect(
        producerFor(discCamera(projType, 0))(def({ placement: 'line' }), ...at),
      ).toBeUndefined()
    })
  }

  it('but the RUNTIME still never reaches them: a tilted disc is promoted to the globe', () => {
    // Recorded so the capability above is not mistaken for a shipped behaviour.
    // `ViewportModeController.setProjection` leaves `pitchLocked` false and lets
    // renderFrame promote a tilted azimuthal projection to projType 7 +
    // globeOrtho, which takes the ECEF projector — so `label-pass` hands the
    // producer no `flat` and the disc billboards. Wiring that is INC-2/INC-4's
    // decision, not INC-1's; INC-1 only removes the reason it was impossible.
    const cam = discCamera(7, 60)
    cam.globeOrtho = true
    cam.azimuthalProjType = 3
    expect(globeProducerFor(cam)(def({ placement: 'line' }), ...at)).toBeUndefined()
  })
})
