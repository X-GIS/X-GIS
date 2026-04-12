import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { evaluate, type FeatureProps } from '../eval/evaluator'
import { lower } from '../ir/lower'
import type * as AST from '../parser/ast'

/** Parse a single expression from "let x = <expr>" */
function parseExpr(source: string): AST.Expr {
  const tokens = new Lexer(`let x = ${source}`).tokenize()
  const ast = new Parser(tokens).parse()
  return (ast.body[0] as AST.LetStatement).value
}

const SHIP: FeatureProps = {
  speed: 15.5,
  heading: 247,
  classification: 'friendly',
  altitude: 150,
  name: 'DDG-65',
}

describe('Evaluator', () => {
  describe('literals', () => {
    it('evaluates numbers', () => {
      expect(evaluate(parseExpr('42'), {})).toBe(42)
      expect(evaluate(parseExpr('3.14'), {})).toBe(3.14)
    })

    it('evaluates strings', () => {
      expect(evaluate(parseExpr('"hello"'), {})).toBe('hello')
    })

    it('evaluates booleans', () => {
      expect(evaluate(parseExpr('true'), {})).toBe(true)
      expect(evaluate(parseExpr('false'), {})).toBe(false)
    })
  })

  describe('field access', () => {
    it('resolves implicit field (.speed)', () => {
      expect(evaluate(parseExpr('.speed'), SHIP)).toBe(15.5)
    })

    it('resolves identifier from props', () => {
      expect(evaluate(parseExpr('speed'), SHIP)).toBe(15.5)
    })

    it('returns null for missing field', () => {
      expect(evaluate(parseExpr('.missing'), SHIP)).toBeNull()
    })
  })

  describe('arithmetic', () => {
    it('evaluates basic ops', () => {
      expect(evaluate(parseExpr('10 + 5'), {})).toBe(15)
      expect(evaluate(parseExpr('10 - 3'), {})).toBe(7)
      expect(evaluate(parseExpr('4 * 5'), {})).toBe(20)
      expect(evaluate(parseExpr('10 / 4'), {})).toBe(2.5)
      expect(evaluate(parseExpr('10 % 3'), {})).toBe(1)
    })

    it('handles division by zero', () => {
      expect(evaluate(parseExpr('5 / 0'), {})).toBe(0)
    })

    it('evaluates with data fields', () => {
      expect(evaluate(parseExpr('.speed / 50'), SHIP)).toBeCloseTo(0.31)
      expect(evaluate(parseExpr('.heading + 90'), SHIP)).toBe(337)
    })
  })

  describe('comparison', () => {
    it('evaluates comparisons', () => {
      expect(evaluate(parseExpr('.speed > 10'), SHIP)).toBe(true)
      expect(evaluate(parseExpr('.speed < 10'), SHIP)).toBe(false)
      expect(evaluate(parseExpr('.altitude >= 150'), SHIP)).toBe(true)
      expect(evaluate(parseExpr('.altitude <= 100'), SHIP)).toBe(false)
    })

    it('evaluates equality', () => {
      expect(evaluate(parseExpr('.classification == "friendly"'), SHIP)).toBe(true)
      expect(evaluate(parseExpr('.classification != "hostile"'), SHIP)).toBe(true)
    })
  })

  describe('logical', () => {
    it('evaluates && and ||', () => {
      expect(evaluate(parseExpr('.speed > 10 && .altitude > 100'), SHIP)).toBe(true)
      expect(evaluate(parseExpr('.speed > 100 || .altitude > 100'), SHIP)).toBe(true)
      expect(evaluate(parseExpr('.speed > 100 && .altitude > 1000'), SHIP)).toBe(false)
    })
  })

  describe('unary', () => {
    it('evaluates negation', () => {
      expect(evaluate(parseExpr('-5'), {})).toBe(-5)
      expect(evaluate(parseExpr('-.speed'), SHIP)).toBe(-15.5)
    })

    it('evaluates logical not', () => {
      expect(evaluate(parseExpr('!true'), {})).toBe(false)
      expect(evaluate(parseExpr('!false'), {})).toBe(true)
    })
  })

  describe('built-in functions', () => {
    it('clamp', () => {
      expect(evaluate(parseExpr('clamp(15, 4, 24)'), {})).toBe(15)
      expect(evaluate(parseExpr('clamp(2, 4, 24)'), {})).toBe(4)
      expect(evaluate(parseExpr('clamp(30, 4, 24)'), {})).toBe(24)
    })

    it('round/floor/ceil', () => {
      expect(evaluate(parseExpr('round(3.7)'), {})).toBe(4)
      expect(evaluate(parseExpr('floor(3.7)'), {})).toBe(3)
      expect(evaluate(parseExpr('ceil(3.2)'), {})).toBe(4)
    })

    it('abs', () => {
      expect(evaluate(parseExpr('abs(-5)'), {})).toBe(5)
    })

    it('min/max', () => {
      expect(evaluate(parseExpr('min(3, 7)'), {})).toBe(3)
      expect(evaluate(parseExpr('max(3, 7)'), {})).toBe(7)
    })

    it('log10', () => {
      expect(evaluate(parseExpr('log10(1000)'), {})).toBeCloseTo(3)
    })

    it('scale', () => {
      expect(evaluate(parseExpr('scale(5, 4)'), {})).toBe(20)
    })
  })

  describe('pipe expressions', () => {
    it('evaluates simple pipe', () => {
      // .speed | round
      expect(evaluate(parseExpr('.speed | round()'), SHIP)).toBe(16)
    })

    it('evaluates chained pipes', () => {
      // .speed / 50 | clamp(0, 1)
      const expr = parseExpr('.speed / 50 | clamp(0, 1)')
      expect(evaluate(expr, SHIP)).toBeCloseTo(0.31)
    })

    it('evaluates data-driven sizing pattern', () => {
      // speed / 50 | clamp(4, 24) — the DESIGN.md pattern
      const expr = parseExpr('.speed * 10 | clamp(4, 24)')
      expect(evaluate(expr, SHIP)).toBe(24) // 155 clamped to 24
      expect(evaluate(expr, { speed: 0.2 })).toBe(4) // 2 clamped to 4
    })
  })
})

describe('Data-driven IR lowering', () => {
  function compile(source: string) {
    const tokens = new Lexer(source).tokenize()
    const ast = new Parser(tokens).parse()
    return lower(ast)
  }

  it('lowers size-[expr] to data-driven SizeValue', () => {
    const scene = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | size-[speed]
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.size.kind).toBe('data-driven')
    if (node.size.kind === 'data-driven') {
      expect(node.size.expr.ast.kind).toBe('Identifier')
    }
  })

  it('lowers constant size', () => {
    const scene = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | size-8
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.size).toEqual({ kind: 'constant', value: 8 })
  })

  it('evaluates data-driven expression against feature', () => {
    const scene = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | size-[speed]
      }
    `)
    const node = scene.renderNodes[0]
    if (node.size.kind === 'data-driven') {
      const result = evaluate(node.size.expr.ast, { speed: 42 })
      expect(result).toBe(42)
    }
  })
})

describe('Filter expression evaluation', () => {
  function compileScene(source: string) {
    const tokens = new Lexer(source).tokenize()
    const ast = new Parser(tokens).parse()
    return lower(ast)
  }

  it('evaluates numeric comparison filter', () => {
    const scene = compileScene(`
      source data { type: geojson, url: "x.geojson" }
      layer big { source: data, filter: .pop > 1000000, fill: red-500 }
    `)
    const filter = scene.renderNodes[0].filter!
    expect(evaluate(filter.ast, { pop: 5000000 })).toBe(true)
    expect(evaluate(filter.ast, { pop: 500 })).toBe(false)
  })

  it('evaluates string equality filter', () => {
    const scene = compileScene(`
      source data { type: geojson, url: "x.geojson" }
      layer rivers { source: data, filter: .type == "river", stroke: blue-500 }
    `)
    const filter = scene.renderNodes[0].filter!
    expect(evaluate(filter.ast, { type: 'river' })).toBe(true)
    expect(evaluate(filter.ast, { type: 'lake' })).toBe(false)
  })

  it('evaluates compound logical filter', () => {
    const scene = compileScene(`
      source data { type: geojson, url: "x.geojson" }
      layer big_cities { source: data, filter: .pop > 500000 && .type == "city", fill: amber-500 }
    `)
    const filter = scene.renderNodes[0].filter!
    expect(evaluate(filter.ast, { pop: 1000000, type: 'city' })).toBe(true)
    expect(evaluate(filter.ast, { pop: 1000000, type: 'town' })).toBe(false)
    expect(evaluate(filter.ast, { pop: 100, type: 'city' })).toBe(false)
  })
})
