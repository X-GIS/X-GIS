import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { resolveUtilities } from '../ir/utility-resolver'
import { resolveColor } from '../tokens/colors'
import type * as AST from '../parser/ast'

function parse(source: string): AST.Program {
  const tokens = new Lexer(source).tokenize()
  return new Parser(tokens).parse()
}

describe('resolveColor', () => {
  it('resolves named colors', () => {
    expect(resolveColor('white')).toBe('#ffffff')
    expect(resolveColor('black')).toBe('#000000')
  })

  it('resolves palette colors', () => {
    expect(resolveColor('red-500')).toBe('#ef4444')
    expect(resolveColor('blue-400')).toBe('#60a5fa')
    expect(resolveColor('green-200')).toBe('#bbf7d0')
    expect(resolveColor('gray-400')).toBe('#9ca3af')
  })

  it('returns null for unknown colors', () => {
    expect(resolveColor('nope')).toBeNull()
    expect(resolveColor('red-999')).toBeNull()
  })
})

describe('resolveUtilities', () => {
  it('resolves fill and stroke', () => {
    const items: AST.UtilityItem[] = [
      { kind: 'UtilityItem', modifier: null, name: 'fill-blue-400', binding: null },
      { kind: 'UtilityItem', modifier: null, name: 'stroke-white', binding: null },
      { kind: 'UtilityItem', modifier: null, name: 'stroke-2', binding: null },
    ]
    const result = resolveUtilities(items)
    expect(result.fill).toBe('#60a5fa')
    expect(result.stroke).toBe('#ffffff')
    expect(result.strokeWidth).toBe(2)
  })

  it('resolves opacity', () => {
    const items: AST.UtilityItem[] = [
      { kind: 'UtilityItem', modifier: null, name: 'opacity-80', binding: null },
    ]
    const result = resolveUtilities(items)
    expect(result.opacity).toBe(0.8)
  })

  it('skips items with modifiers', () => {
    const items: AST.UtilityItem[] = [
      { kind: 'UtilityItem', modifier: null, name: 'fill-red-500', binding: null },
      { kind: 'UtilityItem', modifier: 'z8', name: 'opacity-40', binding: null },
    ]
    const result = resolveUtilities(items)
    expect(result.fill).toBe('#ef4444')
    expect(result.opacity).toBe(1.0) // modifier skipped, default used
  })
})

describe('source/layer → commands pipeline', () => {
  it('parses and resolves MVP example', () => {
    const ast = parse(`
      source world {
        type: geojson
        url: "countries.geojson"
      }

      layer countries {
        source: world
        | fill-blue-400 stroke-white stroke-2 opacity-80
      }
    `)

    // Verify source statement
    const src = ast.body[0] as AST.SourceStatement
    expect(src.kind).toBe('SourceStatement')
    expect(src.name).toBe('world')

    // Verify layer statement
    const layer = ast.body[1] as AST.LayerStatement
    expect(layer.kind).toBe('LayerStatement')

    // Resolve utilities
    const allItems = layer.utilities.flatMap(l => l.items)
    const resolved = resolveUtilities(allItems)
    expect(resolved.fill).toBe('#60a5fa')
    expect(resolved.stroke).toBe('#ffffff')
    expect(resolved.strokeWidth).toBe(2)
    expect(resolved.opacity).toBe(0.8)
  })
})
