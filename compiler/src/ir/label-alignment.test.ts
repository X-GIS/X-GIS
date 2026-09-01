// #777 IV3 — the text-pitch-alignment resolution chain.
//
// The property that matters is not any single row below but the DEFAULT path:
// both knobs default to `auto`, and for line placement that chain lands on
// `map`. Every road name in every basemap goes through it without authoring a
// thing, which is why this is exhaustive over the (placement × rotation × pitch)
// cube rather than spot-checked — an off-by-one in the chain would silently
// change which labels the runtime lays into the ground plane.

import { describe, it, expect } from 'vitest'
import {
  isLinePlacement,
  resolveRotationAlignment,
  resolvePitchAlignment,
  groundAlignsAtRuntime,
} from './label-alignment'

const PLACEMENTS = ['point', 'line', 'line-center', undefined] as const
const KNOBS = ['map', 'viewport', 'auto', undefined] as const

describe('#777 IV3 — isLinePlacement', () => {
  it('is true for exactly the two line placements', () => {
    expect(isLinePlacement('line')).toBe(true)
    expect(isLinePlacement('line-center')).toBe(true)
    for (const p of ['point', undefined, null, '', 'LINE', 42]) {
      expect(isLinePlacement(p)).toBe(false)
    }
  })
})

describe('#777 IV3 — resolveRotationAlignment', () => {
  it('an explicit enum wins over the placement default', () => {
    for (const p of PLACEMENTS) {
      expect(resolveRotationAlignment(p, 'map')).toBe('map')
      expect(resolveRotationAlignment(p, 'viewport')).toBe('viewport')
    }
  })

  it('auto is map for line placement and viewport for point', () => {
    for (const rot of ['auto', undefined, null, 'nonsense']) {
      expect(resolveRotationAlignment('line', rot)).toBe('map')
      expect(resolveRotationAlignment('line-center', rot)).toBe('map')
      expect(resolveRotationAlignment('point', rot)).toBe('viewport')
      expect(resolveRotationAlignment(undefined, rot)).toBe('viewport')
    }
  })
})

describe('#777 IV3 — resolvePitchAlignment', () => {
  it('an explicit pitch enum short-circuits the chain entirely', () => {
    // Including the combinations where it CONTRADICTS the rotation knob: an
    // authored `viewport` on a line label must stay a billboard.
    for (const p of PLACEMENTS) {
      for (const rot of KNOBS) {
        expect(resolvePitchAlignment(p, rot, 'map')).toBe('map')
        expect(resolvePitchAlignment(p, rot, 'viewport')).toBe('viewport')
      }
    }
  })

  it('auto follows the RESOLVED rotation alignment, not the raw knob', () => {
    for (const pitch of ['auto', undefined, null, 'nonsense']) {
      // explicit rotation carries through
      expect(resolvePitchAlignment('point', 'map', pitch)).toBe('map')
      expect(resolvePitchAlignment('line', 'viewport', pitch)).toBe('viewport')
      // rotation auto → placement default → pitch
      expect(resolvePitchAlignment('line', 'auto', pitch)).toBe('map')
      expect(resolvePitchAlignment('point', 'auto', pitch)).toBe('viewport')
    }
  })

  it('THE DEFAULT PATH: both knobs absent, line placement ⇒ map', () => {
    // The whole reason IV3 was re-scoped. Nothing is authored and the label is
    // still ground-aligned by spec.
    expect(resolvePitchAlignment('line', undefined, undefined)).toBe('map')
    expect(resolvePitchAlignment('line-center', undefined, undefined)).toBe('map')
    expect(resolvePitchAlignment('point', undefined, undefined)).toBe('viewport')
  })

  it('never returns `auto` — the whole cube resolves to a concrete value', () => {
    for (const p of PLACEMENTS) {
      for (const rot of KNOBS) {
        for (const pitch of KNOBS) {
          expect(['map', 'viewport']).toContain(resolvePitchAlignment(p, rot, pitch))
        }
      }
    }
  })
})

// #2166 — what the RUNTIME does with the resolved chain, which is a strictly
// smaller set than what the spec asks for. `resolvePitchAlignment` above answers
// "does the spec want this label in the ground plane"; this answers "does
// map/src put it there", and the converter's runtime-gap warning is the
// difference between the two. Exhaustive over the same cube, for the same
// reason: the warning is derived from this predicate, so an off-by-one here
// silently tells an author their working labels are broken (or hides a real
// gap).
describe('#2166 — groundAlignsAtRuntime', () => {
  it('never ground-aligns what the spec resolves to viewport', () => {
    for (const p of PLACEMENTS) {
      for (const rot of KNOBS) {
        for (const pitch of KNOBS) {
          if (resolvePitchAlignment(p, rot, pitch) === 'viewport') {
            expect(groundAlignsAtRuntime(p, rot, pitch)).toBe(false)
          }
        }
      }
    }
  })

  it('POINT placement ground-aligns whenever the chain resolves to map', () => {
    // dispatch-point-labels.ts makeGroundBasisFor gates on nothing else.
    expect(groundAlignsAtRuntime('point', undefined, 'map')).toBe(true)
    expect(groundAlignsAtRuntime('point', 'map', undefined)).toBe(true)
    expect(groundAlignsAtRuntime(undefined, 'map', undefined)).toBe(true)
    // …and stays a billboard on the default point path, which resolves viewport.
    expect(groundAlignsAtRuntime('point', undefined, undefined)).toBe(false)
  })

  it('LINE placement ground-aligns on the default path — the 32-layer basemap case', () => {
    // Nothing authored: auto → rotation auto → map for line. The curved branch
    // walks the label plane, so these labels DO lie in the ground plane and a
    // warning about them is false.
    expect(groundAlignsAtRuntime('line', undefined, undefined)).toBe(true)
    expect(groundAlignsAtRuntime('line', 'auto', 'auto')).toBe(true)
    expect(groundAlignsAtRuntime('line', 'map', 'map')).toBe(true)
  })

  it('LINE + text-rotation-alignment viewport does NOT ground-align even with pitch map', () => {
    // label-pass.ts gates the curved branch on tangent rotation; a viewport-
    // rotated line label never reaches the label-plane walk. Spec-legal, and the
    // one combination where an explicit `map` is genuinely unhonoured.
    expect(groundAlignsAtRuntime('line', 'viewport', 'map')).toBe(false)
  })

  it('LINE-CENTER never ground-aligns, however the chain resolves', () => {
    // Its single-label-per-feature fallback (place-labels-along-line.ts
    // emitLabelAlongSegment) calls addLabel with no basis argument at all.
    for (const rot of KNOBS) {
      for (const pitch of KNOBS) {
        expect(groundAlignsAtRuntime('line-center', rot, pitch)).toBe(false)
      }
    }
  })

  it('is a strict subset of resolvePitchAlignment === map', () => {
    let strictly = 0
    for (const p of PLACEMENTS) {
      for (const rot of KNOBS) {
        for (const pitch of KNOBS) {
          const wanted = resolvePitchAlignment(p, rot, pitch) === 'map'
          const got = groundAlignsAtRuntime(p, rot, pitch)
          expect(wanted || !got).toBe(true)
          if (wanted && !got) strictly++
        }
      }
    }
    // The residual is real, so the subset is PROPER — a predicate that just
    // aliased resolvePitchAlignment would read 0 here and the warning would go
    // silent on cases the runtime really does billboard.
    expect(strictly).toBeGreaterThan(0)
  })
})
