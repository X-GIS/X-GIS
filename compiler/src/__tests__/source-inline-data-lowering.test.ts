// ═══════════════════════════════════════════════════════════════════
// Inline GeoJSON `data: {...}` — parse + IR lowering + LoadCommand threading
// ═══════════════════════════════════════════════════════════════════
//
// Covers the inline-data source feature (`source x { data: {...} }`):
//   - the GOAL program parses `data` to an ObjectLiteral AST node
//   - lowerSource converts it to a plain JS FeatureCollection on
//     SourceDef.inlineData (deep-equal to the expected object)
//   - emitCommands threads inlineData onto the LoadCommand
//   - `data: .field` (a non-literal expression) throws

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { emitCommands } from '../ir/emit-commands'

function parse(source: string) {
  const tokens = new Lexer(source).tokenize()
  return new Parser(tokens).parse()
}
function compile(source: string) {
  return lower(parse(source))
}

// The GOAL program from the feature spec.
const GOAL = `
  source quakes {
    type: geojson
    data: { "type": "FeatureCollection", "features": [
      { "type": "Feature", "geometry": { "type": "Point", "coordinates": [127, 37] }, "properties": { "mag": 5.1 } }
    ] }
  }
  layer q { source: quakes | fill-red size-6 }
`

const EXPECTED_FC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [127, 37] },
      properties: { mag: 5.1 },
    },
  ],
}

describe('source inline data lowering', () => {
  it('parses `data: {...}` to an ObjectLiteral expression', () => {
    const ast = parse(GOAL)
    const src = ast.body.find((s) => s.kind === 'SourceStatement') as any
    expect(src).toBeDefined()
    const dataProp = src.properties.find((p: any) => p.name === 'data')
    expect(dataProp).toBeDefined()
    expect(dataProp.value.kind).toBe('ObjectLiteral')
  })

  it('lowers `data: {...}` to SourceDef.inlineData (deep-equal FeatureCollection)', () => {
    const scene = compile(GOAL)
    expect(scene.sources).toHaveLength(1)
    expect(scene.sources[0].name).toBe('quakes')
    expect(scene.sources[0].inlineData).toEqual(EXPECTED_FC)
  })

  it('parses an empty object literal `data: {}`', () => {
    const scene = compile(`
      source empty {
        type: geojson
        data: {}
      }
    `)
    expect(scene.sources[0].inlineData).toEqual({})
  })

  it('emitCommands threads inlineData onto the LoadCommand', () => {
    const scene = compile(GOAL)
    const commands = emitCommands(scene)
    const load = commands.loads.find((l) => l.name === 'quakes')
    expect(load).toBeDefined()
    expect(load!.inlineData).toEqual(EXPECTED_FC)
  })

  it('warns (but does not throw) when both `data:` and `url:` are set', () => {
    const scene = compile(`
      source both {
        type: geojson
        url: "ignored.geojson"
        data: { "type": "FeatureCollection", "features": [] }
      }
    `)
    expect(scene.sources[0].inlineData).toEqual({ type: 'FeatureCollection', features: [] })
    const warn = (scene.diagnostics ?? []).find((d) => d.code === 'X-GIS0007')
    expect(warn).toBeDefined()
    expect(warn!.severity).toBe('warn')
  })

  it('throws when `data` is a non-literal expression (field access)', () => {
    expect(() =>
      compile(`
        source bad {
          type: geojson
          data: .field
        }
      `),
    ).toThrow(/data.*(inline|literal|object)/i)
  })

  it('throws when an inline object value is a non-literal expression', () => {
    // `coordinates: [.lon, .lat]` — the array element is a FieldAccess, which
    // astLiteralToJS rejects (inline data must be static literal GeoJSON).
    expect(() =>
      compile(`
        source bad2 {
          type: geojson
          data: { "type": "FeatureCollection", "features": [
            { "type": "Feature", "geometry": { "type": "Point", "coordinates": [.lon, .lat] } }
          ] }
        }
      `),
    ).toThrow(/literal GeoJSON/i)
  })

  it('preserves NEGATIVE coordinates (W/S hemispheres)', () => {
    // The parser tokenises `-122.4` as a unary-minus over NumberLiteral, NOT
    // a negative literal; astLiteralToJS must fold it back to a signed number.
    // Real GeoJSON is full of negatives — without this, most data fails to
    // parse (fail-before: threw "got a 'UnaryExpr' expression").
    const ir = compile(`
      source sf {
        type: geojson
        data: { "type": "FeatureCollection", "features": [
          { "type": "Feature", "geometry": { "type": "Point", "coordinates": [-122.4, -37.8] }, "properties": {} }
        ] }
      }
      layer l { source: sf | fill-red size-6 }
    `)
    const src = ir.sources.find((s) => s.name === 'sf')!
    const coords = (src.inlineData as { features: { geometry: { coordinates: number[] } }[] })
      .features[0].geometry.coordinates
    expect(coords).toEqual([-122.4, -37.8])
  })
})
