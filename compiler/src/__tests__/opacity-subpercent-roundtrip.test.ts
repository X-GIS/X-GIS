// FIX 1 — Mapbox fill/line-opacity in the sub-~1.5% range collapses to
// FULL opacity (100×). The converter emits 0..100 tokens
// (Math.round(0.01*100) = 1) and the lower pass's `num <= 1 ? num :
// num/100` heuristic then reads `opacity-1` as the legacy 0..1 form
// (1.0 = full) instead of the 0..100 form (1 = 1%). Any opacity in
// ~(0, 0.015) therefore renders at 100×.
//
// These pin the round-trip through the real lexer→parser→lower path.
// The converter ALWAYS emits 0..100 (1.0 → opacity-100, 0.5 → opacity-50,
// 0 → opacity-0), so the lower pass must treat the token as 0..100
// unconditionally. After the fix: opacity-1 → 0.01, opacity-50 → 0.5,
// opacity-100 → 1.0, opacity-0 → 0.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { withPragma } from './_pragma'

function compile(source: string) {
  const tokens = new Lexer(withPragma(source)).tokenize()
  const ast = new Parser(tokens).parse()
  return lower(ast)
}

function nodeFor(opacityToken: string) {
  const scene = compile(`
    source data { type: geojson, url: "x.geojson" }
    layer l { source: data | fill-#000000 ${opacityToken} }
  `)
  return scene.renderNodes[0]
}

describe('FIX 1 — constant opacity round-trip (0..100 token)', () => {
  it('opacity-1 (Mapbox 0.01) lowers to ~0.01, NOT 1.0', () => {
    const node = nodeFor('opacity-1')
    expect(node.opacity.kind).toBe('constant')
    if (node.opacity.kind === 'constant') {
      expect(node.opacity.value).toBeCloseTo(0.01, 5)
    }
  })

  it('opacity-50 still lowers to 0.5', () => {
    const node = nodeFor('opacity-50')
    if (node.opacity.kind === 'constant') expect(node.opacity.value).toBeCloseTo(0.5, 5)
    else throw new Error('expected constant')
  })

  it('opacity-100 still lowers to 1.0 (full)', () => {
    const node = nodeFor('opacity-100')
    if (node.opacity.kind === 'constant') expect(node.opacity.value).toBeCloseTo(1.0, 5)
    else throw new Error('expected constant')
  })

  it('opacity-0 still lowers to 0 (transparent)', () => {
    const node = nodeFor('opacity-0')
    if (node.opacity.kind === 'constant') expect(node.opacity.value).toBeCloseTo(0.0, 5)
    else throw new Error('expected constant')
  })
})

describe('FIX 1 — zoom-interp opacity stops scale individually', () => {
  it('interpolate(zoom, 10, 1, 16, 50) lowers to [0.01, 0.5], NOT [1.0, 0.5]', () => {
    const scene = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer l { source: data | fill-#000000 opacity-[interpolate(zoom, 10, 1, 16, 50)] }
    `)
    const node = scene.renderNodes[0]
    expect(node.opacity.kind).toBe('zoom-interpolated')
    if (node.opacity.kind === 'zoom-interpolated') {
      const byZoom = new Map(node.opacity.stops.map((s) => [s.zoom, s.value]))
      expect(byZoom.get(10)).toBeCloseTo(0.01, 5)
      expect(byZoom.get(16)).toBeCloseTo(0.5, 5)
    }
  })
})
