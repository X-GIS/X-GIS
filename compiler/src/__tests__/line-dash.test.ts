import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'

function compile(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  return lower(ast)
}

// Runs the FULL production pipeline including `optimize`, which is what
// `map.ts` uses. A bug in `optimizeNode` previously dropped every stroke
// field other than color/width.
function compileToCommandsOptimized(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  return emitCommands(optimize(lower(ast), ast))
}

function compileToCommands(source: string) {
  return emitCommands(compile(source))
}

describe('stroke-dasharray parsing', () => {
  const DEMO_SOURCE = `
    source coast {
      type: geojson
      url: "ne_110m_coastline.geojson"
    }
    layer simple_dash {
      source: coast
      | stroke-sky-400 stroke-2
      | stroke-dasharray-20-10
    }
  `

  it('tokenizes stroke-dasharray-20-10 into a single utility name', () => {
    const src = 'layer foo { source: s | stroke-dasharray-20-10 }'
    const tokens = new Lexer(src).tokenize()
    // Look for the dasharray sequence
    const names = tokens.map(t => t.value).join(' ')
    expect(names).toContain('stroke - dasharray - 20 - 10')
  })

  it('parses stroke-dasharray-20-10 as a single utility item', () => {
    const ast = new Parser(new Lexer(`
      source s { type: geojson url: "x.geojson" }
      layer foo {
        source: s
        | stroke-dasharray-20-10
      }
    `).tokenize()).parse()
    const layerStmt = ast.body.find(s => s.kind === 'LayerStatement')!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const util = (layerStmt as any).utilities[0].items[0]
    expect(util.name).toBe('stroke-dasharray-20-10')
  })

  it('lowers stroke-dasharray-20-10 to StrokeValue.dashArray = [20, 10]', () => {
    const scene = compile(DEMO_SOURCE)
    expect(scene.renderNodes).toHaveLength(1)
    const node = scene.renderNodes[0]
    expect(node.stroke.dashArray).toBeDefined()
    expect(node.stroke.dashArray).toEqual([20, 10])
  })

  it('emits dashArray into the ShowCommand', () => {
    const commands = compileToCommands(DEMO_SOURCE)
    expect(commands.shows).toHaveLength(1)
    const show = commands.shows[0]
    expect(show.dashArray).toEqual([20, 10])
  })

  it('rejects single-value dasharrays (< 2 entries)', () => {
    const scene = compile(`
      source s { type: geojson url: "x.geojson" }
      layer foo {
        source: s
        | stroke-dasharray-20
      }
    `)
    expect(scene.renderNodes[0].stroke.dashArray).toBeUndefined()
  })

  it('parses composite dasharrays with 4 values', () => {
    const scene = compile(`
      source s { type: geojson url: "x.geojson" }
      layer foo {
        source: s
        | stroke-dasharray-6-2-1-2
      }
    `)
    expect(scene.renderNodes[0].stroke.dashArray).toEqual([6, 2, 1, 2])
  })

  it('optimize() preserves stroke dashArray (regression guard for optimizeNode)', () => {
    const commands = compileToCommandsOptimized(DEMO_SOURCE)
    const show = commands.shows[0]
    expect(show.dashArray).toEqual([20, 10])
  })

  it('optimize() preserves ALL extended stroke fields', () => {
    const commands = compileToCommandsOptimized(`
      source s { type: geojson url: "x.geojson" }
      symbol marker { path "M -1 -1 L 1 -1 L 1 1 L -1 1 Z" }
      layer foo {
        source: s
        | stroke-red-500 stroke-3 stroke-round-join stroke-round-cap
        | stroke-dasharray-10-5
        | stroke-pattern-marker stroke-pattern-spacing-40px stroke-pattern-size-10px
      }
    `)
    const show = commands.shows[0]
    expect(show.strokeWidth).toBe(3)
    expect(show.linecap).toBe('round')
    expect(show.linejoin).toBe('round')
    expect(show.dashArray).toEqual([10, 5])
    expect(show.patterns).toBeDefined()
    expect(show.patterns).toHaveLength(1)
    expect(show.patterns![0].shape).toBe('marker')
  })

  it('still shows that the old underscore form FAILS to parse (regression guard)', () => {
    // If this ever starts producing a dashArray, the lexer has changed and
    // we can drop the workaround. Until then, underscore form is broken.
    const scene = compile(`
      source s { type: geojson url: "x.geojson" }
      layer foo {
        source: s
        | stroke-dasharray-20_10
      }
    `)
    expect(scene.renderNodes[0].stroke.dashArray).toBeUndefined()
  })
})
