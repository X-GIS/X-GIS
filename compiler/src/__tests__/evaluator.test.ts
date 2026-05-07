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

  describe('trigonometry', () => {
    it('sin/cos/tan', () => {
      expect(evaluate(parseExpr('sin(0)'), {})).toBe(0)
      expect(evaluate(parseExpr('cos(0)'), {})).toBe(1)
      expect(evaluate(parseExpr('sin(3.14159265 / 2)'), {})).toBeCloseTo(1)
    })

    it('atan2', () => {
      expect(evaluate(parseExpr('atan2(1, 0)'), {})).toBeCloseTo(Math.PI / 2)
    })

    it('pow/exp/log', () => {
      expect(evaluate(parseExpr('pow(2, 10)'), {})).toBe(1024)
      expect(evaluate(parseExpr('exp(0)'), {})).toBe(1)
      expect(evaluate(parseExpr('log(1)'), {})).toBe(0)
    })

    it('PI/TAU constants', () => {
      expect(evaluate(parseExpr('PI()'), {})).toBeCloseTo(Math.PI)
      expect(evaluate(parseExpr('TAU()'), {})).toBeCloseTo(Math.PI * 2)
    })
  })

  describe('ternary conditional', () => {
    it('evaluates true branch', () => {
      expect(evaluate(parseExpr('10 > 5 ? 1 : 0'), {})).toBe(1)
    })

    it('evaluates false branch', () => {
      expect(evaluate(parseExpr('3 > 5 ? 1 : 0'), {})).toBe(0)
    })

    it('works with field access', () => {
      expect(evaluate(parseExpr('.speed > 10 ? "fast" : "slow"'), SHIP)).toBe('fast')
      expect(evaluate(parseExpr('.speed > 100 ? "fast" : "slow"'), SHIP)).toBe('slow')
    })

    it('nested ternary', () => {
      expect(evaluate(parseExpr('.speed > 100 ? "fast" : .speed > 10 ? "medium" : "slow"'), SHIP)).toBe('medium')
    })
  })

  describe('arrays', () => {
    it('evaluates array literal', () => {
      const result = evaluate(parseExpr('[1, 2, 3]'), {})
      expect(result).toEqual([1, 2, 3])
    })

    it('evaluates nested array', () => {
      const result = evaluate(parseExpr('[[1, 2], [3, 4]]'), {})
      expect(result).toEqual([[1, 2], [3, 4]])
    })

    it('length builtin', () => {
      expect(evaluate(parseExpr('length([10, 20, 30])'), {})).toBe(3)
    })
  })

  describe('user functions with control flow', () => {
    function evalWithFn(fnSrc: string, callSrc: string, props: FeatureProps = {}): unknown {
      const tokens = new Lexer(`${fnSrc}\nlet result = ${callSrc}`).tokenize()
      const ast = new Parser(tokens).parse()
      const fnStmt = ast.body[0] as AST.FnStatement
      const letStmt = ast.body[1] as AST.LetStatement
      const fnEnv = new Map([[fnStmt.name, fnStmt]])
      return evaluate(letStmt.value, props, fnEnv)
    }

    it('if/else with return', () => {
      expect(evalWithFn(
        'fn classify(x: f32) -> f32 { if x > 10 { return 1.0 } else { return 0.0 } }',
        'classify(20)'
      )).toBe(1)

      expect(evalWithFn(
        'fn classify(x: f32) -> f32 { if x > 10 { return 1.0 } else { return 0.0 } }',
        'classify(5)'
      )).toBe(0)
    })

    it('else if chain', () => {
      expect(evalWithFn(
        'fn grade(x: f32) -> f32 { if x > 90 { return 4.0 } else if x > 80 { return 3.0 } else { return 2.0 } }',
        'grade(95)'
      )).toBe(4)
      expect(evalWithFn(
        'fn grade(x: f32) -> f32 { if x > 90 { return 4.0 } else if x > 80 { return 3.0 } else { return 2.0 } }',
        'grade(85)'
      )).toBe(3)
    })

    it('for loop with last expression', () => {
      const result = evalWithFn(
        `fn sum_to(n: f32) -> f32 {
          let total = 0
          for i in 0..4 {
            let total = total + i
          }
          return total
        }`,
        'sum_to(4)'
      )
      // 0+1+2+3 = 6
      expect(result).toBe(6)
    })

    it('trig in function body', () => {
      const result = evalWithFn(
        `fn circle_point(angle: f32) -> array {
          return [cos(angle), sin(angle)]
        }`,
        'circle_point(0)'
      )
      expect(result).toEqual([1, 0])
    })
  })

  describe('geometry builtins', () => {
    it('circle generates closed ring', () => {
      const result = evaluate(parseExpr('circle(0, 0, 1, 4)'), {}) as number[][]
      expect(result).toHaveLength(5) // 4 segments + closing point
      expect(result[0][0]).toBeCloseTo(1) // first point at (1,0)
      expect(result[0][1]).toBeCloseTo(0)
      expect(result[4][0]).toBeCloseTo(result[0][0]) // closed
      expect(result[4][1]).toBeCloseTo(result[0][1])
    })

    it('arc generates partial ring', () => {
      const result = evaluate(parseExpr('arc(0, 0, 1, 0, 3.14159265, 4)'), {}) as number[][]
      expect(result).toHaveLength(5) // 4+1 points for half circle
      expect(result[0][0]).toBeCloseTo(1)  // start at (1,0)
      expect(result[4][0]).toBeCloseTo(-1) // end at (-1,0)
    })
  })

  describe('match() FnCall dispatch', () => {
    // Regression guard for the layer-merge fix (5f6b06e). The
    // mergeLayers pass synthesises `match(.field) { value -> N }`
    // ASTs that the worker evaluates per feature. Before the fix,
    // FnCall fell through to callBuiltin('match', args) which
    // doesn't know about match → every call returned null →
    // per-feature stroke widths / colours never made it into the
    // segment buffer.
    function makeMatchAst(field: string, arms: Array<{ pattern: string; value: number | string }>): AST.Expr {
      const matchArms: AST.MatchArm[] = arms.map(a => ({
        pattern: a.pattern,
        value: typeof a.value === 'number'
          ? { kind: 'NumberLiteral', value: a.value } as AST.Expr
          : { kind: 'StringLiteral', value: a.value } as AST.Expr,
      }))
      return {
        kind: 'FnCall',
        callee: { kind: 'Identifier', name: 'match' } as AST.Expr,
        args: [{ kind: 'FieldAccess', object: null, field } as unknown as AST.Expr],
        matchBlock: { kind: 'MatchBlock', arms: matchArms },
      } as unknown as AST.Expr
    }

    it('returns the matching arm value for a string key', () => {
      const ast = makeMatchAst('kind', [
        { pattern: 'park', value: 'green' },
        { pattern: 'water', value: 'blue' },
        { pattern: '_', value: 'gray' },
      ])
      expect(evaluate(ast, { kind: 'park' })).toBe('green')
      expect(evaluate(ast, { kind: 'water' })).toBe('blue')
    })

    it('falls back to the _ default arm for an unmatched key', () => {
      const ast = makeMatchAst('kind', [
        { pattern: 'a', value: 1 },
        { pattern: '_', value: 99 },
      ])
      expect(evaluate(ast, { kind: 'unknown' })).toBe(99)
    })

    it('returns null when key is missing AND no default arm', () => {
      const ast = makeMatchAst('kind', [
        { pattern: 'a', value: 1 },
      ])
      expect(evaluate(ast, {})).toBeNull()
    })

    it('numeric arms work for stroke-width match (roads_* path)', () => {
      // Mirrors the merge pass's per-feature width AST shape.
      const ast = makeMatchAst('kind', [
        { pattern: 'minor_road', value: 0.5 },
        { pattern: 'primary', value: 2.5 },
        { pattern: 'highway', value: 3.5 },
        { pattern: '_', value: 0 },
      ])
      expect(evaluate(ast, { kind: 'minor_road' })).toBe(0.5)
      expect(evaluate(ast, { kind: 'primary' })).toBe(2.5)
      expect(evaluate(ast, { kind: 'highway' })).toBe(3.5)
      // Unmatched: default arm value 0 — feeds the worker's
      // "no override; use layer width" sentinel.
      expect(evaluate(ast, { kind: 'service' })).toBe(0)
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
    expect(node.size).toMatchObject({ kind: 'constant', value: 8 })
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
