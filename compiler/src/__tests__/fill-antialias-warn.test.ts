// fill-antialias surface + opt-out propagation.
//
// Default `true` matches X-GIS runtime (the fill fragment multiplies in
// the sphere-rim smoothstep) → no spurious warning when authored
// explicitly. `false` is now IMPLEMENTED end-to-end: the converter emits
// a `fill-antialias-false` flag that flows Mapbox → ShowCommand
// .fillAntialias = false, and the runtime gates the rim smoothstep off.
// So `false` no longer warns; instead it propagates the flag.

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
      id: 'land',
      type: 'fill',
      source: 'v',
      'source-layer': 'land',
      paint: {
        'fill-color': '#ddd',
        'fill-antialias': value,
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

describe('fill-antialias surface + opt-out propagation', () => {
  it('omitted → no warning, fillAntialias undefined (default path)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const style = buildStyle(undefined)
    delete (style.layers[0]!.paint as Record<string, unknown>)['fill-antialias']
    convertMapboxStyle(style as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('fill-antialias'))).toBe(false)
    const shows = compileToShows(style)
    expect(shows[0]!.fillAntialias).toBeUndefined()
  })

  it('explicit true (spec default) → no warning, fillAntialias undefined', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(true) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('fill-antialias'))).toBe(false)
    expect(compileToShows(buildStyle(true))[0]!.fillAntialias).toBeUndefined()
  })

  it('["literal", true] → no warning (v8 strict wrap)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(['literal', true]) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('fill-antialias'))).toBe(false)
  })

  it('false → no warn, fillAntialias=false propagated to ShowCommand', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(false) as never, { coverage })
    // Implemented now — the false case no longer surfaces a gap warning.
    expect(coverage.warnings.some(w => w.includes('fill-antialias'))).toBe(false)
    const shows = compileToShows(buildStyle(false))
    expect(shows[0]!.fillAntialias).toBe(false)
  })

  it('["literal", false] → fillAntialias=false (v8 strict wrap honoured)', () => {
    const shows = compileToShows(buildStyle(['literal', false]))
    expect(shows[0]!.fillAntialias).toBe(false)
  })

  it('emits the fill-antialias-false utility in the xgis source', () => {
    const xgis = convertMapboxStyle(buildStyle(false) as Parameters<typeof convertMapboxStyle>[0])
    expect(xgis).toContain('fill-antialias-false')
  })
})
