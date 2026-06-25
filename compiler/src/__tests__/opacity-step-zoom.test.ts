// Issue #607 — zoom-stepped opacity (`step(zoom, …)`) must lower to
// `zoom-interpolated` so the runtime skips (composedOpa < 0.005) the layer
// outside its visible range.
//
// Root cause: `extractInterpolateZoomStops` only handled `interpolate` /
// `interpolate_exp` callee names. A `step(zoom, 100, 7, 0)` binding fell
// through to `data-driven`, and `resolveNumberShape` for data-driven always
// returns 1 — so the layer was never hidden. The fix adds
// `extractStepZoomStops` which maps the N-stop Mapbox step form to a pair
// of adjacent zoom stops at each breakpoint (ε = 0.0001 zoom units) so
// the existing interpolateZoom infrastructure produces the stepped behavior.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'

function compile(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  return lower(ast)
}

function nodeFor(opacityBinding: string) {
  const scene = compile(`
    source data { type: geojson, url: "x.geojson" }
    layer l { source: data | fill-#000000 ${opacityBinding} }
  `)
  return scene.renderNodes[0]
}

describe('step(zoom, …) opacity — issue #607', () => {
  it('step(zoom, 100, 7, 0) lowers to zoom-interpolated, NOT data-driven', () => {
    // Mapbox: ["step", ["zoom"], 1, 7, 0] → visible at zoom < 7, hidden at ≥ 7
    // Converter emits 0..100 scale: opacity-[step(zoom, 100, 7, 0)]
    const node = nodeFor('opacity-[step(zoom, 100, 7, 0)]')
    expect(node.opacity.kind).toBe('zoom-interpolated')
  })

  it('step(zoom, 100, 7, 0) stops: value at zoom < 7 is ~1.0 (visible)', () => {
    const node = nodeFor('opacity-[step(zoom, 100, 7, 0)]')
    if (node.opacity.kind !== 'zoom-interpolated') throw new Error('expected zoom-interpolated')
    // The first stop is at zoom=7, value=100/100=1.0
    const firstStop = node.opacity.stops[0]
    expect(firstStop).toBeDefined()
    expect(firstStop!.zoom).toBeCloseTo(7, 3)
    expect(firstStop!.value).toBeCloseTo(1.0, 3)
  })

  it('step(zoom, 100, 7, 0) stops: value at zoom > 7+ε is ~0.0 (hidden)', () => {
    const node = nodeFor('opacity-[step(zoom, 100, 7, 0)]')
    if (node.opacity.kind !== 'zoom-interpolated') throw new Error('expected zoom-interpolated')
    // The second stop is at zoom=7+ε, value=0/100=0.0
    const secondStop = node.opacity.stops[1]
    expect(secondStop).toBeDefined()
    expect(secondStop!.zoom).toBeGreaterThan(7)
    expect(secondStop!.value).toBeCloseTo(0.0, 3)
  })

  it('multi-breakpoint step(zoom, 100, 4, 50, 8, 0) produces 4 stops', () => {
    // zoom < 4 → 1.0, zoom ≥ 4 → 0.5, zoom ≥ 8 → 0.0
    const node = nodeFor('opacity-[step(zoom, 100, 4, 50, 8, 0)]')
    expect(node.opacity.kind).toBe('zoom-interpolated')
    if (node.opacity.kind !== 'zoom-interpolated') throw new Error('expected zoom-interpolated')
    expect(node.opacity.stops.length).toBe(4)
    // First pair: z=4, value=1.0 → z=4+ε, value=0.5
    expect(node.opacity.stops[0]!.zoom).toBeCloseTo(4, 3)
    expect(node.opacity.stops[0]!.value).toBeCloseTo(1.0, 3)
    expect(node.opacity.stops[1]!.zoom).toBeGreaterThan(4)
    expect(node.opacity.stops[1]!.value).toBeCloseTo(0.5, 3)
    // Second pair: z=8, value=0.5 → z=8+ε, value=0.0
    expect(node.opacity.stops[2]!.zoom).toBeCloseTo(8, 3)
    expect(node.opacity.stops[2]!.value).toBeCloseTo(0.5, 3)
    expect(node.opacity.stops[3]!.zoom).toBeGreaterThan(8)
    expect(node.opacity.stops[3]!.value).toBeCloseTo(0.0, 3)
  })

  it('step with non-zoom input stays data-driven (per-feature step)', () => {
    // ["step", ["get", "rank"], 1, 3, 0] — data-driven, NOT zoom
    const node = nodeFor('opacity-[step(.rank, 100, 3, 0)]')
    expect(node.opacity.kind).toBe('data-driven')
  })
})
