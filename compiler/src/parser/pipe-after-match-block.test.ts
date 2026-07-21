// #1236 — a second `|` utility line directly after a match-block utility must
// parse. The docs promise "multiple `|` blocks compose", and both a second `|`
// after a SIMPLE utility and a same-block continuation after a match block
// already parse — only the match-block + new-`|` combination failed with
// "Expected utility name, got Minus".

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from './parser'
import type * as AST from './ast'

const parse = (src: string) => new Parser(new Lexer(src).tokenize()).parse()

const layerOf = (program: AST.Program): AST.LayerStatement => {
  const layer = program.body.find((s): s is AST.LayerStatement => s.kind === 'LayerStatement')
  expect(layer).toBeTruthy()
  return layer!
}

describe('second | utility line after a match-block utility (#1236)', () => {
  it('parses the issue repro: | fill match(){} then | stroke-white stroke-1', () => {
    const program = parse(`xgis 1

source land { type: geojson, url: "x.geojson" }

layer c {
  source: land
  | fill match(.C) {
      "Asia" -> red-400,
      _ -> gray-300
    }
  | stroke-white stroke-1
}
`)
    const layer = layerOf(program)
    expect(layer.utilities.length).toBe(2)
    const first = layer.utilities[0]!
    expect(first.items.length).toBe(1)
    expect(first.items[0]!.name).toBe('fill')
    expect(first.items[0]!.binding?.kind).toBe('FnCall')
    expect((first.items[0]!.binding as AST.FnCall).matchBlock?.arms.length).toBe(2)
    const second = layer.utilities[1]!
    expect(second.items.map((i) => i.name)).toEqual(['stroke-white', 'stroke-1'])
  })

  it('control: same-block continuation after the match block still parses', () => {
    const program = parse(`xgis 1

source land { type: geojson, url: "x.geojson" }

layer c {
  source: land
  | fill match(.C) {
      "Asia" -> red-400,
      _ -> gray-300
    }
    stroke-white stroke-1
}
`)
    const layer = layerOf(program)
    expect(layer.utilities.length).toBe(1)
    expect(layer.utilities[0]!.items.map((i) => i.name)).toEqual([
      'fill',
      'stroke-white',
      'stroke-1',
    ])
  })

  it('control: second | after a SIMPLE utility still parses', () => {
    const program = parse(`xgis 1

source land { type: geojson, url: "x.geojson" }

layer c {
  source: land
  | fill-red-400
  | stroke-white stroke-1
}
`)
    const layer = layerOf(program)
    expect(layer.utilities.length).toBe(2)
  })
})
