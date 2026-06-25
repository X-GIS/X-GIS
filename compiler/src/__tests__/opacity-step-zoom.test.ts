// Issue #607 — zoom-stepped opacity (`step(zoom, …)`) must lower to
// `zoom-interpolated` so the runtime skips (composedOpa < 0.005) the layer
// outside its visible range.
//
// The previous fix (29b98739) had two bugs found by adversarial verification:
//
//   1. Double-scaling: the test used `step(zoom, 100, 7, 0)` (0..100 scale)
//      but the REAL converter form is `step(zoom, 1, 7, 0)` (raw 0..1).
//      The converter's addOpacity passes step values through exprToXgis
//      as-is (no *100 scaling — only the interpolate path pre-scales).
//      The lowerer divided by 100, producing 0.01 instead of 1.0: the
//      canonical Mapbox show/hide idiom ["step",["zoom"],1,7,0] rendered
//      at 1% opacity below z7 (nearly invisible ghost).
//
//   2. Boundary inversion: old code emitted {z, def}, {z+ε, v} so
//      interpolateZoom at zoom==z clamped to def (the BELOW value). Mapbox
//      and X-GIS's own step evaluator both use input >= stop → val, so
//      zoom==z should yield v (the AT-OR-ABOVE value). Fixed to emit
//      {z-ε, def}, {z, v}.

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

describe('step(zoom, …) opacity — issue #607 v2', () => {
  // ── Discriminating test: real converter form (raw 0..1) ──

  it('REAL FORM step(zoom, 1, 7, 0): lowers to zoom-interpolated, NOT data-driven', () => {
    // Mapbox ["step", ["zoom"], 1, 7, 0] → addOpacity → exprToXgis →
    // opacity-[step(zoom, 1, 7, 0)].  Raw 0..1 values, NO pre-scaling.
    // Pre-fix (29b98739): data-driven → resolves to 1.0 always (never hidden).
    const node = nodeFor('opacity-[step(zoom, 1, 7, 0)]')
    expect(node.opacity.kind).toBe('zoom-interpolated')
  })

  it('REAL FORM step(zoom, 1, 7, 0): below-breakpoint value is 1.0 (NOT 0.01)', () => {
    // Pre-fix: /100 applied to raw value 1 → 0.01 (1% opacity ghost).
    // Post-fix: raw value 1 kept as-is → 1.0 (fully visible).
    const node = nodeFor('opacity-[step(zoom, 1, 7, 0)]')
    if (node.opacity.kind !== 'zoom-interpolated') throw new Error('expected zoom-interpolated')
    // The stop just before z7 must have value 1.0 (fully visible below z7).
    const belowStop = node.opacity.stops.find(s => s.zoom < 7)
    expect(belowStop).toBeDefined()
    expect(belowStop!.value).toBeCloseTo(1.0, 3)
  })

  it('REAL FORM step(zoom, 1, 7, 0): at-breakpoint value (zoom==7) is 0.0 (hidden)', () => {
    // Boundary: zoom==7 must resolve to the >= value (0.0 = hidden),
    // matching Mapbox step semantics. Pre-fix emitted {z, def}, {z+ε, v}
    // so interpolateZoom(zoom==7) clamped to def (1.0 = visible — wrong).
    const node = nodeFor('opacity-[step(zoom, 1, 7, 0)]')
    if (node.opacity.kind !== 'zoom-interpolated') throw new Error('expected zoom-interpolated')
    // The stop AT z7 must have value 0.0 (hidden at and above z7).
    const atStop = node.opacity.stops.find(s => Math.abs(s.zoom - 7) < 1e-9)
    expect(atStop).toBeDefined()
    expect(atStop!.value).toBeCloseTo(0.0, 3)
    // And all stops with zoom >= 7 must also be 0.0.
    const aboveStops = node.opacity.stops.filter(s => s.zoom >= 7)
    for (const s of aboveStops) {
      expect(s.value).toBeCloseTo(0.0, 3)
    }
  })

  it('REAL FORM step(zoom, 0, 7, 1): below-breakpoint is 0.0, at/above is 1.0', () => {
    // Inverse pattern: hidden below z7, visible at and above.
    const node = nodeFor('opacity-[step(zoom, 0, 7, 1)]')
    if (node.opacity.kind !== 'zoom-interpolated') throw new Error('expected zoom-interpolated')
    const belowStop = node.opacity.stops.find(s => s.zoom < 7)
    expect(belowStop!.value).toBeCloseTo(0.0, 3)
    const atStop = node.opacity.stops.find(s => Math.abs(s.zoom - 7) < 1e-9)
    expect(atStop!.value).toBeCloseTo(1.0, 3)
  })

  it('multi-breakpoint step(zoom, 1, 4, 0.5, 8, 0): 4 stops, correct values', () => {
    // zoom < 4 → 1.0, zoom ≥ 4 → 0.5, zoom ≥ 8 → 0.0
    const node = nodeFor('opacity-[step(zoom, 1, 4, 0.5, 8, 0)]')
    expect(node.opacity.kind).toBe('zoom-interpolated')
    if (node.opacity.kind !== 'zoom-interpolated') throw new Error('expected zoom-interpolated')
    expect(node.opacity.stops.length).toBe(4)
    // Stop before z4: value 1.0
    expect(node.opacity.stops[0]!.zoom).toBeLessThan(4)
    expect(node.opacity.stops[0]!.value).toBeCloseTo(1.0, 3)
    // Stop AT z4: value 0.5
    expect(node.opacity.stops[1]!.zoom).toBeCloseTo(4, 3)
    expect(node.opacity.stops[1]!.value).toBeCloseTo(0.5, 3)
    // Stop before z8: value 0.5
    expect(node.opacity.stops[2]!.zoom).toBeLessThan(8)
    expect(node.opacity.stops[2]!.value).toBeCloseTo(0.5, 3)
    // Stop AT z8: value 0.0
    expect(node.opacity.stops[3]!.zoom).toBeCloseTo(8, 3)
    expect(node.opacity.stops[3]!.value).toBeCloseTo(0.0, 3)
  })

  it('step with non-zoom input stays data-driven (per-feature step)', () => {
    // ["step", ["get", "rank"], 1, 3, 0] — data-driven, NOT zoom
    const node = nodeFor('opacity-[step(.rank, 1, 3, 0)]')
    expect(node.opacity.kind).toBe('data-driven')
  })

  // ── Interpolate path unchanged ──

  it('interpolate(zoom, …) opacity still divides by 100 correctly', () => {
    // The interpolate path remains pre-scaled 0..100 by the converter.
    // opacity-[interpolate(zoom, 10, 20, 16, 80)] → stops 0.2, 0.8.
    const node = nodeFor('opacity-[interpolate(zoom, 10, 20, 16, 80)]')
    expect(node.opacity.kind).toBe('zoom-interpolated')
    if (node.opacity.kind !== 'zoom-interpolated') throw new Error('expected zoom-interpolated')
    const s0 = node.opacity.stops[0]!
    const s1 = node.opacity.stops[1]!
    expect(s0.zoom).toBeCloseTo(10, 3)
    expect(s0.value).toBeCloseTo(0.2, 3)
    expect(s1.zoom).toBeCloseTo(16, 3)
    expect(s1.value).toBeCloseTo(0.8, 3)
  })
})
