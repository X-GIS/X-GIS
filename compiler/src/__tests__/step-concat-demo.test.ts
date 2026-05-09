// Sanity-check the playground step-and-concat demo source compiles.

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { evaluate } from '../eval/evaluator'

const DEMO = `
source places { type: geojson, url: "data/x.geojson" }

layer city_dots {
  source: places
  | size-[step(.pop_max, 3, 100000, 5, 1000000, 7, 5000000, 10)]
  | fill-[step(.pop_max, "#4ade80", 1000000, "#facc15", 5000000, "#f97316", 10000000, "#ef4444")]
    fill-opacity-90
}

layer city_labels {
  source: places
  | label-[concat(.name, ", ", .adm0name, "  (", round(.pop_max / 1000), "k)")]
    label-size-11 label-color-#fff
}
`

describe('step + concat playground demo source', () => {
  it('lexes + parses + lowers without throwing', () => {
    const tokens = new Lexer(DEMO).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    expect(scene.renderNodes.length).toBe(2)
  })

  it('runtime evaluator handles N-stop step + concat with sample feature', () => {
    const props = {
      pop_max: 7_500_000,
      name: 'Tokyo',
      adm0name: 'Japan',
    }
    // Inline parse the bindings the same way the runtime would.
    const tokens = new Lexer(`source x { type: geojson } layer y { source: x | size-[step(.pop_max, 3, 100000, 5, 1000000, 7, 5000000, 10)] }`).tokenize()
    const ast = new Parser(tokens).parse()
    // Find the size binding's AST node and evaluate it directly.
    const layer = ast.body.find(s => s.kind === 'LayerStatement') as never
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sizeBinding = (layer as any).utilities[0].items[0].binding
    const result = evaluate(sizeBinding, props)
    // pop_max=7.5M ≥ 5M → step yields 10.
    expect(result).toBe(10)
  })

  it('concat coerces numerics + drops nulls', () => {
    const tokens = new Lexer(`source x { type: geojson } layer y { source: x | label-[concat(.name, " (", round(.pop_max / 1000), "k)")] }`).tokenize()
    const ast = new Parser(tokens).parse()
    const layer = ast.body.find(s => s.kind === 'LayerStatement') as never
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const labelBinding = (layer as any).utilities[0].items[0].binding
    const result = evaluate(labelBinding, { name: 'Tokyo', pop_max: 13_500_000 })
    expect(result).toBe('Tokyo (13500k)')
  })
})
