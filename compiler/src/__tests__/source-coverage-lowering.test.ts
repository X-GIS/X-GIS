// ═══════════════════════════════════════════════════════════════════
// `type: coverage` display options — IR lowering + LoadCommand threading
// ═══════════════════════════════════════════════════════════════════
//
// #1158 / #1272. The grammar + schema are pinned by schema/coverage-source.test.ts;
// this covers the LOWERING half the render wiring depends on:
//   • lowerSource emits SourceDef.ramp / SourceDef.range from the source block
//   • emitCommands threads both onto the LoadCommand (the runtime arms the
//     CoverageRenderer off `SceneCommands.loads[i]`)
//   • a malformed `range` fails LOUDLY (a wrong window would recolour data)
//   • absent ramp/range leave the fields undefined (renderer defaults apply)

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { emitCommands } from '../ir/emit-commands'
import { withPragma } from './_pragma'

function compile(source: string) {
  const tokens = new Lexer(withPragma(source)).tokenize()
  const ast = new Parser(tokens).parse()
  return lower(ast)
}

describe('coverage source ramp/range lowering', () => {
  it('lowerSource emits SourceDef.ramp + SourceDef.range from the source block', () => {
    const scene = compile(`
      source currents {
        type: coverage
        url: "SEA_S111_2026.xgcov"
        ramp: "viridis"
        range: [0, 2]
      }
    `)
    expect(scene.sources).toHaveLength(1)
    expect(scene.sources[0].ramp).toBe('viridis')
    expect(scene.sources[0].range).toEqual([0, 2])
  })

  it('coverage source with no ramp/range leaves both undefined (renderer defaults)', () => {
    const scene = compile(`
      source cov {
        type: coverage
        url: "x.xgcov"
      }
    `)
    expect(scene.sources[0].ramp).toBeUndefined()
    expect(scene.sources[0].range).toBeUndefined()
  })

  it('emitCommands threads ramp + range onto the LoadCommand', () => {
    const scene = compile(`
      source currents {
        type: coverage
        url: "SEA_S111_2026.xgcov"
        ramp: "viridis"
        range: [0, 2]
      }
      layer speed {
        source: currents
      }
    `)
    const load = emitCommands(scene).loads.find((l) => l.name === 'currents')
    expect(load).toBeDefined()
    expect(load!.ramp).toBe('viridis')
    expect(load!.range).toEqual([0, 2])
  })

  it('a malformed range (wrong arity) throws a clear error naming the source', () => {
    expect(() =>
      compile(`
        source cov {
          type: coverage
          url: "x.xgcov"
          range: [0, 40, 80]
        }
      `),
    ).toThrow(/cov[\s\S]*range[\s\S]*two-number/i)
  })

  it('a non-numeric range element throws (a string window is not a value window)', () => {
    expect(() =>
      compile(`
        source cov {
          type: coverage
          url: "x.xgcov"
          range: ["lo", "hi"]
        }
      `),
    ).toThrow(/range[\s\S]*two-number/i)
  })
})
