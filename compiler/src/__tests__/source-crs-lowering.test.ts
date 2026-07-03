// ═══════════════════════════════════════════════════════════════════
// Source-level input CRS — IR lowering + LoadCommand threading
// ═══════════════════════════════════════════════════════════════════
//
// Plan: EPSG input-reprojection (Task T2). Covers:
//   AC1   — lowerSource emits SourceDef.crs from a constant `crs:"..."`
//   AC2   — geojson source with no crs defaults to "EPSG:4326"
//   AC10  — type:vector + crs throws a clear error
//   AC11a — emitCommands LoadCommand carries crs (URL-fetch path carrier)

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { emitCommands } from '../ir/emit-commands'

function compile(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  return lower(ast)
}

describe('source crs lowering', () => {
  it('AC1: lowerSource emits SourceDef.crs from a constant crs property', () => {
    const scene = compile(`
      source korea {
        type: geojson
        url: "korea.geojson"
        crs: "EPSG:5179"
      }
    `)
    expect(scene.sources).toHaveLength(1)
    expect(scene.sources[0].crs).toBe('EPSG:5179')
  })

  it('AC2: geojson source with no crs defaults to EPSG:4326', () => {
    const scene = compile(`
      source world {
        type: geojson
        url: "countries.geojson"
      }
    `)
    expect(scene.sources[0].crs).toBe('EPSG:4326')
  })

  it('AC10: type:vector with a crs throws a clear error naming the source', () => {
    expect(() =>
      compile(`
        source tiles {
          type: vector
          url: "tiles.pmtiles"
          crs: "EPSG:5179"
        }
      `),
    ).toThrow(/tiles[\s\S]*crs[\s\S]*not supported/i)
  })

  it('vector source without a crs leaves crs unset (no 4326 default)', () => {
    const scene = compile(`
      source tiles {
        type: vector
        url: "tiles.pmtiles"
      }
    `)
    expect(scene.sources[0].crs).toBeUndefined()
  })

  it('AC11a: emitCommands LoadCommand carries crs from SourceDef', () => {
    const scene = compile(`
      source korea {
        type: geojson
        url: "korea.geojson"
        crs: "EPSG:5179"
      }
      layer k {
        source: korea
        | fill-blue-400
      }
    `)
    const commands = emitCommands(scene)
    const load = commands.loads.find((l) => l.name === 'korea')
    expect(load).toBeDefined()
    expect(load!.crs).toBe('EPSG:5179')
  })

  it('Step12: expression-form crs (non-StringLiteral) throws "not implemented" error at lowering', () => {
    // `crs: [.srid]` parses as a FieldAccess expression, not a StringLiteral.
    // lowerSource must reject it immediately with a clear message instead of
    // silently ignoring the property and applying a wrong projection.
    expect(() =>
      compile(`
        source korea {
          type: geojson
          url: "korea.geojson"
          crs: [.srid]
        }
      `),
    ).toThrow(/crs.*constant.*string|constant.*EPSG|not implemented/i)
  })

  it('AC11a: LoadCommand crs defaults to EPSG:4326 for geojson with no crs', () => {
    const scene = compile(`
      source world {
        type: geojson
        url: "world.geojson"
      }
      layer w {
        source: world
        | fill-blue-400
      }
    `)
    const commands = emitCommands(scene)
    const load = commands.loads.find((l) => l.name === 'world')
    expect(load!.crs).toBe('EPSG:4326')
  })
})
