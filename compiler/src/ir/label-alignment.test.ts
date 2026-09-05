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
  tangentRotates,
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

  it('POINT placement NEVER ground-aligns on the tiled column, even resolving to map', () => {
    // The predicate models the tiled dispatch column (see its DOMAIN note), and
    // there the point arms call addLabel with ten arguments — they stop before
    // the basis parameter. makeGroundBasisFor is wired on the RAW-dataset point
    // arm only, which is a source-kind fact no per-layer predicate can read.
    // These three read `true` before #2166's correction and were the shipped
    // false silence: a vector-tile POI layer authoring `map` got no warning and
    // no ground plane.
    expect(groundAlignsAtRuntime('point', undefined, 'map')).toBe(false)
    expect(groundAlignsAtRuntime('point', 'map', undefined)).toBe(false)
    expect(groundAlignsAtRuntime(undefined, 'map', undefined)).toBe(false)
    // …and it is a billboard on the default point path too, which resolves
    // viewport — same answer, but reached by the resolve gate rather than here.
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

// ═══ #2224 — the FOURTH enum value ═══
//
// `viewport-glyph` is spec-valid (the pinned @maplibre/maplibre-gl-style-spec
// lists map | viewport | viewport-glyph | auto). MapLibre's `recalculate`
// rewrites only `auto`, so the value reaches its `pitchWithMap` test spelled
// `=== 'map'` and is FALSE there: the label billboards. Before this suite it
// fell through every arm here to the placement default — `map` on a line layer
// — which is the opposite, and the two gates that spelled `!== 'viewport'`
// each disagreed with it independently.

describe('#2224 — viewport-glyph resolves to the viewport side', () => {
  it('resolveRotationAlignment maps it to viewport at every placement', () => {
    for (const p of PLACEMENTS) {
      expect(resolveRotationAlignment(p, 'viewport-glyph')).toBe('viewport')
    }
  })

  it('the pitch chain inherits it — auto pitch on a viewport-glyph line layer is viewport', () => {
    for (const pitch of ['auto', undefined, null]) {
      expect(resolvePitchAlignment('line', 'viewport-glyph', pitch)).toBe('viewport')
      expect(resolvePitchAlignment('line-center', 'viewport-glyph', pitch)).toBe('viewport')
      expect(resolvePitchAlignment('point', 'viewport-glyph', pitch)).toBe('viewport')
    }
    // An EXPLICIT pitch map still wins the chain — the rotation knob only
    // supplies the `auto` fallback.
    expect(resolvePitchAlignment('line', 'viewport-glyph', 'map')).toBe('map')
  })

  it('a viewport-glyph line layer does NOT ground-align, at any pitch knob', () => {
    for (const pitch of ['map', 'auto', undefined]) {
      expect(groundAlignsAtRuntime('line', 'viewport-glyph', pitch)).toBe(false)
    }
  })

  it('an UNKNOWN value still falls to the placement default (not silently viewport)', () => {
    // The guard that keeps this from being "anything not `map` is viewport":
    // a typo must behave as `auto` did, which the converter warns about
    // separately.
    expect(resolveRotationAlignment('line', 'viewport-glyphs')).toBe('map')
    expect(groundAlignsAtRuntime('line', 'viewport-glyphs', 'map')).toBe(true)
  })
})

describe('#2224 — tangentRotates is the one predicate both gates read', () => {
  it('agrees with resolveRotationAlignment === map over the whole cube', () => {
    for (const p of [...PLACEMENTS, 'LINE', 42]) {
      for (const rot of [...KNOBS, 'viewport-glyph', 'nonsense', null]) {
        expect(tangentRotates(p, rot)).toBe(resolveRotationAlignment(p, rot) === 'map')
      }
    }
  })

  it('a line layer follows the tangent by default and billboards on either viewport value', () => {
    expect(tangentRotates('line', undefined)).toBe(true)
    expect(tangentRotates('line', 'auto')).toBe(true)
    expect(tangentRotates('line', 'map')).toBe(true)
    expect(tangentRotates('line', 'viewport')).toBe(false)
    expect(tangentRotates('line', 'viewport-glyph')).toBe(false)
  })

  it('the ground gate is exactly this predicate on the line cell', () => {
    // The #2224 defect in one assertion: the two gates must never disagree
    // about a line layer whose pitch chain resolves to map.
    for (const rot of [...KNOBS, 'viewport-glyph']) {
      expect(groundAlignsAtRuntime('line', rot, 'map')).toBe(tangentRotates('line', rot))
    }
  })
})
