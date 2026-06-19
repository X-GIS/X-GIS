// fill-extrusion-vertical-gradient surface + opt-out propagation.
//
// Default `true` per Mapbox spec; X-GIS' extrude vertex shader applies
// the 0.7→1.0 wall ramp → setting `true` is a no-op match and emits no
// warning. Setting `false` is now IMPLEMENTED end-to-end: the converter
// emits a `fill-extrusion-vertical-gradient-false` flag that flows
// Mapbox → ShowCommand.fillExtrusionVerticalGradient = false, and the
// runtime ANDs it off in vs_main_ecef_extruded (flat wall shading). So
// `false` no longer warns; instead it propagates the flag.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'

function buildStyle(value: unknown) {
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [{
      id: 'bldg',
      type: 'fill-extrusion',
      source: 'v',
      'source-layer': 'building',
      paint: {
        'fill-extrusion-color': '#aaa',
        'fill-extrusion-height': 10,
        'fill-extrusion-vertical-gradient': value,
      },
    }],
  }
}

function compileToShows(mapboxStyle: unknown): ReturnType<typeof emitCommands>['shows'] {
  const xgisSource = convertMapboxStyle(mapboxStyle as Parameters<typeof convertMapboxStyle>[0])
  const tokens = new Lexer(xgisSource).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  return emitCommands(optimize(scene, ast)).shows
}

describe('fill-extrusion-vertical-gradient surface + opt-out propagation', () => {
  it('omitted → no warning, flag undefined (default ramp)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const style = buildStyle(undefined)
    delete (style.layers[0]!.paint as Record<string, unknown>)['fill-extrusion-vertical-gradient']
    convertMapboxStyle(style as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('vertical-gradient'))).toBe(false)
    expect(compileToShows(style)[0]!.fillExtrusionVerticalGradient).toBeUndefined()
  })

  it('explicit true (spec default) → no warning, flag undefined', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(true) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('vertical-gradient'))).toBe(false)
    expect(compileToShows(buildStyle(true))[0]!.fillExtrusionVerticalGradient).toBeUndefined()
  })

  it('["literal", true] (v8 strict wrap) → no warning', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(['literal', true]) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('vertical-gradient'))).toBe(false)
  })

  it('false → no warn, flag=false propagated to ShowCommand', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(false) as never, { coverage })
    // Implemented now — the false case no longer surfaces a gap warning.
    expect(coverage.warnings.some(w => w.includes('vertical-gradient'))).toBe(false)
    expect(compileToShows(buildStyle(false))[0]!.fillExtrusionVerticalGradient).toBe(false)
  })

  it('["literal", false] → flag=false (v8 strict wrap honoured)', () => {
    expect(compileToShows(buildStyle(['literal', false]))[0]!.fillExtrusionVerticalGradient).toBe(false)
  })

  it('null (spec: fall back to default) → no warning, flag undefined', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(null) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('vertical-gradient'))).toBe(false)
    expect(compileToShows(buildStyle(null))[0]!.fillExtrusionVerticalGradient).toBeUndefined()
  })

  it('emits the fill-extrusion-vertical-gradient-false utility', () => {
    const xgis = convertMapboxStyle(buildStyle(false) as Parameters<typeof convertMapboxStyle>[0])
    expect(xgis).toContain('fill-extrusion-vertical-gradient-false')
  })
})
