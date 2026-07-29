// #777 IV3 — the text-pitch-alignment resolution chain.
//
// The property that matters is not any single row below but the DEFAULT path:
// both knobs default to `auto`, and for line placement that chain lands on
// `map`. Every road name in every basemap goes through it without authoring a
// thing, which is why this is exhaustive over the (placement × rotation × pitch)
// cube rather than spot-checked — an off-by-one in the chain would silently
// change which labels the runtime lays into the ground plane.

import { describe, it, expect } from 'vitest'
import { isLinePlacement, resolveRotationAlignment, resolvePitchAlignment } from './label-alignment'

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
