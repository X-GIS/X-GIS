// End-to-end coverage for Mapbox `["interpolate", ["exponential", N], …]`.
// Pre-fix: the converter dropped the curve type silently, so every
// exponential road-width curve in OFM Bright was rendered as linear —
// 65 layers across `paint.line-width` plus 4 `text-size` + 1
// `fill-opacity`. Visible mismatch: roads too thick at low zoom + too
// thin at high zoom, vs MapLibre.
//
// Post-fix: paint.ts emits `interpolate_exp(zoom, base, z1, v1, …)`
// when the Mapbox curve is `["exponential", N]` with N ≠ 1; lower.ts
// extracts `{ base, stops }`; emit-commands threads `base` onto
// ShowCommand; runtime interpolateZoom applies the Mapbox-spec curve.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, Lexer, Parser, lower, emitCommands } from '../index'
import { evaluate } from '../eval/evaluator'

describe('interpolate-exponential conversion', () => {
  it('exponential line-width emits interpolate_exp(zoom, base, …)', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'road',
        type: 'line',
        source: 'v',
        'source-layer': 'roads',
        paint: {
          'line-width': ['interpolate', ['exponential', 1.3], ['zoom'],
            11, 1,
            19, 2.5],
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toContain('interpolate_exp(zoom, 1.3, 11, 1, 19, 2.5)')
    // Linear sibling should keep the existing form.
    expect(xgis).not.toContain('interpolate(zoom, 11, 1, 19, 2.5)')
  })

  it('exponential with base 1 collapses to linear', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'road',
        type: 'line',
        source: 'v',
        'source-layer': 'roads',
        paint: {
          'line-width': ['interpolate', ['exponential', 1], ['zoom'],
            11, 1, 19, 2.5],
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    // base=1 is mathematically linear; emit the cheaper form so the
    // runtime takes the linear fast path.
    expect(xgis).toContain('interpolate(zoom, 11, 1, 19, 2.5)')
    expect(xgis).not.toContain('interpolate_exp')
  })

  it('linear curve keeps the existing form', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'road',
        type: 'line',
        source: 'v',
        'source-layer': 'roads',
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'],
            11, 1, 19, 2.5],
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toContain('interpolate(zoom, 11, 1, 19, 2.5)')
    expect(xgis).not.toContain('interpolate_exp')
  })

  it('cubic-bezier curve warns and falls back to linear', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'road',
        type: 'line',
        source: 'v',
        'source-layer': 'roads',
        paint: {
          'line-width': ['interpolate', ['cubic-bezier', 0, 0.5, 1, 0.5], ['zoom'],
            11, 1, 19, 2.5],
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    // Falls through to linear (no bezier evaluator).
    expect(xgis).toContain('interpolate(zoom, 11, 1, 19, 2.5)')
    expect(xgis).toMatch(/cubic-bezier/) // warning in trailing notes
  })
})

describe('interpolate-exponential lower → IR', () => {
  function lowerOnce(src: string) {
    const tokens = new Lexer(src).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    return scene.renderNodes[0]
  }

  it('exponential size carries base on SizeValue.zoom-interpolated', () => {
    // `size-` flows into the zoom-interpolated SizeValue path which is
    // where lower.ts wires the base through. (Stroke-width takes the
    // data-driven `widthExpr` path; that's exercised in the evaluator
    // section below.)
    const src = `
source v { type: pmtiles, url: "x.pmtiles" }
layer pts {
  source: v
  sourceLayer: "places"
  | size-[interpolate_exp(zoom, 1.3, 11, 1, 19, 2.5)]
}
`
    const node = lowerOnce(src)
    const sz = node!.size
    expect(sz.kind).toBe('zoom-interpolated')
    if (sz.kind !== 'zoom-interpolated') return
    expect(sz.base).toBe(1.3)
    expect(sz.stops.length).toBe(2)
    expect(sz.stops[0]).toEqual({ zoom: 11, value: 1 })
    expect(sz.stops[1]).toEqual({ zoom: 19, value: 2.5 })
  })

  it('linear size omits base', () => {
    const src = `
source v { type: pmtiles, url: "x.pmtiles" }
layer pts {
  source: v
  sourceLayer: "places"
  | size-[interpolate(zoom, 11, 1, 19, 2.5)]
}
`
    const node = lowerOnce(src)
    const sz = node!.size
    expect(sz.kind).toBe('zoom-interpolated')
    if (sz.kind !== 'zoom-interpolated') return
    expect(sz.base).toBeUndefined()
  })
})

describe('interpolate-exponential emit-commands → ShowCommand', () => {
  it('exponential size + opacity stops carry base on ShowCommand', () => {
    const src = `
source v { type: pmtiles, url: "x.pmtiles" }
layer pts {
  source: v
  sourceLayer: "places"
  | size-[interpolate_exp(zoom, 2.0, 0, 4, 22, 64)] opacity-[interpolate_exp(zoom, 1.8, 0, 0, 5, 1)]
}
`
    const tokens = new Lexer(src).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    const cmds = emitCommands(scene)
    const show = cmds.shows[0]!
    expect(show.zoomSizeStopsBase).toBe(2.0)
    expect(show.zoomOpacityStopsBase).toBe(1.8)
  })
})

describe('interpolate-exponential evaluator (data-driven path)', () => {
  it('matches Mapbox exponential formula at midpoint', () => {
    // base=2, stops (0, 0) and (10, 100). At zoom=5:
    //   t = (2^5 - 1) / (2^10 - 1) = 31 / 1023 ≈ 0.0303
    //   v = 0 + 100 * t ≈ 3.03
    const ast = {
      kind: 'FnCall',
      callee: { kind: 'Identifier', name: 'interpolate_exp' },
      args: [
        { kind: 'NumberLiteral', value: 5 },
        { kind: 'NumberLiteral', value: 2 },
        { kind: 'NumberLiteral', value: 0 },
        { kind: 'NumberLiteral', value: 0 },
        { kind: 'NumberLiteral', value: 10 },
        { kind: 'NumberLiteral', value: 100 },
      ],
    }
    const result = evaluate(ast as never, {}) as number
    const expected = 100 * ((2 ** 5 - 1) / (2 ** 10 - 1))
    expect(result).toBeCloseTo(expected, 6)
  })

  it('interpolate (linear) keeps existing behaviour', () => {
    // Sanity that the shared switch arm still handles plain interpolate.
    const ast = {
      kind: 'FnCall',
      callee: { kind: 'Identifier', name: 'interpolate' },
      args: [
        { kind: 'NumberLiteral', value: 5 },
        { kind: 'NumberLiteral', value: 0 },
        { kind: 'NumberLiteral', value: 0 },
        { kind: 'NumberLiteral', value: 10 },
        { kind: 'NumberLiteral', value: 100 },
      ],
    }
    expect(evaluate(ast as never, {}) as number).toBe(50)
  })

  it('base=1 in interpolate_exp matches linear', () => {
    const ast = {
      kind: 'FnCall',
      callee: { kind: 'Identifier', name: 'interpolate_exp' },
      args: [
        { kind: 'NumberLiteral', value: 5 },
        { kind: 'NumberLiteral', value: 1 },
        { kind: 'NumberLiteral', value: 0 },
        { kind: 'NumberLiteral', value: 0 },
        { kind: 'NumberLiteral', value: 10 },
        { kind: 'NumberLiteral', value: 100 },
      ],
    }
    expect(evaluate(ast as never, {}) as number).toBe(50)
  })
})
