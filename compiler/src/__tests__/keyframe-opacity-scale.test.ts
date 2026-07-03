// FIX — keyframe-animated opacity used the legacy `num <= 1 ? num :
// num/100` dual-scale heuristic (lower-animation.ts:78). The
// opacity-<N> utility is the 0..100 scale and the converter ALWAYS
// emits 0..100 (Mapbox fill-opacity 0.01 → opacity-1). The static arm
// (lower.ts) and the zoom-interp arm were already fixed unconditionally
// (see opacity-subpercent-roundtrip.test.ts), but the keyframe
// expansion sub-pass still read `opacity-1` as the 0..1 form (1.0 =
// full opaque) → 100× too opaque on keyframe-animated opacity.
//
// After the fix the keyframe expansion treats the token as 0..100
// unconditionally: opacity-1 → 0.01, opacity-50 → 0.5, opacity-100 → 1.0.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'

function compile(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  return lower(ast)
}

describe('FIX — keyframe-animated opacity round-trip (0..100 token)', () => {
  it('opacity-1 (Mapbox 0.01) keyframe stop lowers to 0.01, NOT 1.0', () => {
    const scene = compile(`
      keyframes blink {
        0%:   opacity-1
        100%: opacity-100
      }
      source data { type: geojson, url: "x.geojson" }
      layer blinking {
        source: data
        | fill-red-500
        | animation-blink animation-duration-1000 animation-infinite
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.opacity.kind).toBe('time-interpolated')
    if (node.opacity.kind !== 'time-interpolated') throw new Error('wrong kind')
    const byTime = new Map(node.opacity.stops.map((s) => [s.timeMs, s.value]))
    // fail-before: 1.0 (the `num <= 1 ? num` arm read 1 as the 0..1 form)
    expect(byTime.get(0)).toBeCloseTo(0.01, 5)
    expect(byTime.get(1000)).toBeCloseTo(1.0, 5)
  })

  it('opacity-50 keyframe stop still lowers to 0.5', () => {
    const scene = compile(`
      keyframes fade {
        0%:   opacity-100
        100%: opacity-50
      }
      source data { type: geojson, url: "x.geojson" }
      layer fading {
        source: data
        | fill-blue-500
        | animation-fade animation-duration-1000
      }
    `)
    const node = scene.renderNodes[0]
    if (node.opacity.kind !== 'time-interpolated') throw new Error('wrong kind')
    const byTime = new Map(node.opacity.stops.map((s) => [s.timeMs, s.value]))
    expect(byTime.get(0)).toBeCloseTo(1.0, 5)
    expect(byTime.get(1000)).toBeCloseTo(0.5, 5)
  })
})
