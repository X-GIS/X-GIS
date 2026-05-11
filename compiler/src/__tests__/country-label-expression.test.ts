// Throwaway diagnostic. Verifies how `text-field` for country labels
// flows through the lowering + evaluator + text-resolver pipeline.

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { evaluate } from '../eval/evaluator'

const COUNTRY_LABEL_SRC = `
source x { type: pmtiles, url: "x.pmtiles" }
layer label_country_3 {
  source: x
  sourceLayer: "place"
  | label-[get("name:nonlatin") != null ? concat(get("name:latin"), "\\n", get("name:nonlatin")) : .name_en ?? .name] label-color-#000 label-size-12 label-halo-1 label-halo-color-#fff label-font-Noto-Sans label-font-weight-700
}
`

describe('country label expression — diagnostic', () => {
  it('lowers without dropping the label and produces a kind:expr TextValue', () => {
    const tokens = new Lexer(COUNTRY_LABEL_SRC).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    const layer = scene.renderNodes.find((l: { name?: string }) => l.name === 'label_country_3') as { name: string; label?: import('../ir/render-node').LabelDef } | undefined
    expect(layer).toBeDefined()
    expect(layer!.label).toBeDefined()
    expect(layer!.label!.text).toBeDefined()
    expect(layer!.label!.size).toBe(12)
    expect(layer!.label!.color).toEqual([0, 0, 0, 1])
    expect(layer!.label!.halo).toBeDefined()
    expect(layer!.label!.halo!.color).toEqual([1, 1, 1, 1])
  })

  it('evaluates expression for a Latin-only feature (e.g. France)', () => {
    const tokens = new Lexer(COUNTRY_LABEL_SRC).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    const layer = scene.renderNodes.find((l: { name?: string }) => l.name === 'label_country_3') as { label: import('../ir/render-node').LabelDef }
    const text = layer.label.text
    expect(text.kind).toBe('expr')
    if (text.kind !== 'expr') throw new Error('unreachable')
    const result = evaluate(text.expr.ast, {
      name: 'France',
      name_en: 'France',
      class: 'country',
      rank: 1,
    })
    expect(result).toBe('France')
  })

  it('evaluates expression for a feature with name:nonlatin (e.g. South Korea)', () => {
    const tokens = new Lexer(COUNTRY_LABEL_SRC).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    const layer = scene.renderNodes.find((l: { name?: string }) => l.name === 'label_country_3') as { label: import('../ir/render-node').LabelDef }
    const text = layer.label.text
    if (text.kind !== 'expr') throw new Error('unreachable')
    const result = evaluate(text.expr.ast, {
      name: '대한민국',
      name_en: 'South Korea',
      'name:latin': 'South Korea',
      'name:nonlatin': '대한민국',
      class: 'country',
      rank: 1,
    })
    // Expected: concat("South Korea", "\n", "대한민국")
    expect(result).toBe('South Korea\n대한민국')
  })

  it('evaluates expression for a feature with name only (no name_en)', () => {
    const tokens = new Lexer(COUNTRY_LABEL_SRC).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    const layer = scene.renderNodes.find((l: { name?: string }) => l.name === 'label_country_3') as { label: import('../ir/render-node').LabelDef }
    const text = layer.label.text
    if (text.kind !== 'expr') throw new Error('unreachable')
    const result = evaluate(text.expr.ast, {
      name: 'Atlantis',
      class: 'country',
    })
    // .name_en absent → coalesces to .name
    expect(result).toBe('Atlantis')
  })
})
