// ═══ Parameterized presets (#1536) — parser shapes ═══
// Step-2 surface: `preset name(a, b) { … }` declarations and
// `apply-name(args…)` utility items. Written fail-before: each case
// pins the post-change AST shape.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import type * as AST from '../parser/ast'
import { withPragma } from './_pragma'

function parse(source: string): AST.Program {
  const tokens = new Lexer(withPragma(source)).tokenize()
  return new Parser(tokens).parse()
}

function firstPreset(source: string): AST.PresetStatement {
  const stmt = parse(source).body.find((s) => s.kind === 'PresetStatement')
  if (!stmt) throw new Error('no PresetStatement parsed')
  return stmt as AST.PresetStatement
}

function firstLayerItems(source: string): AST.UtilityItem[] {
  const stmt = parse(source).body.find((s) => s.kind === 'LayerStatement') as
    AST.LayerStatement | undefined
  if (!stmt) throw new Error('no LayerStatement parsed')
  return stmt.utilities.flatMap((l) => l.items)
}

describe('preset parameter declarations (#1536)', () => {
  it('parses `preset glow(color, radius)` into params', () => {
    const p = firstPreset('preset glow(color, radius) { | stroke-[color] stroke-[radius] }')
    expect(p.name).toBe('glow')
    expect(p.params).toEqual(['color', 'radius'])
    expect(p.utilities).toHaveLength(1)
  })

  it('zero-arg presets keep parsing with no params (back-compat)', () => {
    const p = firstPreset('preset plain { | fill-red-500 }')
    expect(p.name).toBe('plain')
    expect(p.params).toBeUndefined()
  })

  it('single-param declaration parses', () => {
    const p = firstPreset('preset halo(width) { | stroke-[width] }')
    expect(p.params).toEqual(['width'])
  })
})

describe('apply-<preset>(args) utility items (#1536)', () => {
  const SRC = `
source w { type: geojson, url: "w.geojson" }
preset glow(color, radius) { | stroke-[color] stroke-[radius] }
layer roads {
  source: w
  | apply-glow(#f59e0b, 4) opacity-80
}
`

  it('parses call-form apply items into UtilityItem.args', () => {
    const items = firstLayerItems(SRC)
    const apply = items.find((i) => i.name === 'apply-glow')
    expect(apply).toBeDefined()
    expect(apply!.args).toHaveLength(2)
    expect(apply!.args![0].kind).toBe('ColorLiteral')
    expect(apply!.args![1].kind).toBe('NumberLiteral')
  })

  it('sibling items after the call survive', () => {
    const items = firstLayerItems(SRC)
    expect(items.some((i) => i.name === 'opacity-80')).toBe(true)
  })

  it('bare apply items keep args undefined (back-compat)', () => {
    const items = firstLayerItems(`
source w { type: geojson, url: "w.geojson" }
preset plain { | fill-red-500 }
layer l { source: w  | apply-plain }
`)
    const apply = items.find((i) => i.name === 'apply-plain')
    expect(apply).toBeDefined()
    expect(apply!.args).toBeUndefined()
  })
})
