import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { classifyExpr, type FnEnv } from '../ir/classify'
import { constFold } from '../ir/const-fold'
import type * as AST from '../parser/ast'

function parseExpr(source: string): AST.Expr {
  const tokens = new Lexer(`let x = ${source}`).tokenize()
  const ast = new Parser(tokens).parse()
  return (ast.body[0] as AST.LetStatement).value
}

function compile(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  return { scene: lower(ast), ast }
}

describe('Expression Classifier', () => {
  it('classifies literals as constant', () => {
    expect(classifyExpr(parseExpr('42'))).toBe('constant')
    expect(classifyExpr(parseExpr('"hello"'))).toBe('constant')
    expect(classifyExpr(parseExpr('true'))).toBe('constant')
    expect(classifyExpr(parseExpr('#ff0000'))).toBe('constant')
  })

  it('classifies pure arithmetic as constant', () => {
    expect(classifyExpr(parseExpr('360 / 12'))).toBe('constant')
    expect(classifyExpr(parseExpr('0.5 * 0.8'))).toBe('constant')
    expect(classifyExpr(parseExpr('10 + 20 * 3'))).toBe('constant')
  })

  it('classifies built-in calls with constant args as constant', () => {
    expect(classifyExpr(parseExpr('clamp(100, 4, 24)'))).toBe('constant')
    expect(classifyExpr(parseExpr('round(3.7)'))).toBe('constant')
    expect(classifyExpr(parseExpr('abs(-5)'))).toBe('constant')
  })

  it('classifies field access as per-feature-gpu', () => {
    expect(classifyExpr(parseExpr('speed'))).toBe('per-feature-gpu')
    expect(classifyExpr(parseExpr('.speed'))).toBe('per-feature-gpu')
    expect(classifyExpr(parseExpr('speed * 2'))).toBe('per-feature-gpu')
  })

  it('classifies zoom as zoom-dependent', () => {
    expect(classifyExpr(parseExpr('zoom'))).toBe('zoom-dependent')
    expect(classifyExpr(parseExpr('zoom + 1'))).toBe('zoom-dependent')
  })

  it('classifies pipes correctly', () => {
    // constant pipe: all constant
    expect(classifyExpr(parseExpr('100 | clamp(4, 24)'))).toBe('constant')
    // per-feature pipe
    expect(classifyExpr(parseExpr('speed | clamp(4, 24)'))).toBe('per-feature-gpu')
  })

  it('classifies user functions with constant args as constant', () => {
    const fnEnv: FnEnv = new Map()
    const tokens = new Lexer(`fn double(x: f32) -> f32 { x * 2 }`).tokenize()
    const ast = new Parser(tokens).parse()
    const fn = ast.body[0] as AST.FnStatement
    fnEnv.set('double', fn)

    expect(classifyExpr(parseExpr('double(15)'), fnEnv)).toBe('constant')
  })

  it('classifies user functions with data args as per-feature', () => {
    const fnEnv: FnEnv = new Map()
    const tokens = new Lexer(`fn double(x: f32) -> f32 { x * 2 }`).tokenize()
    const ast = new Parser(tokens).parse()
    fnEnv.set('double', ast.body[0] as AST.FnStatement)

    expect(classifyExpr(parseExpr('double(speed)'), fnEnv)).toBe('per-feature-gpu')
  })
})

describe('Constant Folder', () => {
  it('folds pure arithmetic', () => {
    expect(constFold(parseExpr('360 / 12'))).toEqual({ value: 30 })
    expect(constFold(parseExpr('0.5 * 0.8'))).toEqual({ value: 0.4 })
  })

  it('folds built-in function calls', () => {
    expect(constFold(parseExpr('clamp(100, 4, 24)'))).toEqual({ value: 24 })
    expect(constFold(parseExpr('round(3.7)'))).toEqual({ value: 4 })
    expect(constFold(parseExpr('abs(-5)'))).toEqual({ value: 5 })
  })

  it('folds constant pipe expressions', () => {
    expect(constFold(parseExpr('100 | clamp(4, 24)'))).toEqual({ value: 24 })
  })

  it('does not fold expressions with field access', () => {
    expect(constFold(parseExpr('speed * 2'))).toBeNull()
    expect(constFold(parseExpr('.speed | clamp(4, 24)'))).toBeNull()
  })

  it('folds user-defined function with constant args', () => {
    const fnEnv: FnEnv = new Map()
    const tokens = new Lexer(`fn double(x: f32) -> f32 { x * 2 }`).tokenize()
    const ast = new Parser(tokens).parse()
    fnEnv.set('double', ast.body[0] as AST.FnStatement)

    expect(constFold(parseExpr('double(15)'), fnEnv)).toEqual({ value: 30 })
  })

  it('folds nested user function calls', () => {
    const fnEnv: FnEnv = new Map()
    const tokens = new Lexer(`
      fn scale(x: f32, factor: f32) -> f32 { x * factor }
    `).tokenize()
    const ast = new Parser(tokens).parse()
    fnEnv.set('scale', ast.body[0] as AST.FnStatement)

    expect(constFold(parseExpr('scale(5, 10)'), fnEnv)).toEqual({ value: 50 })
  })
})

describe('Optimize Pass', () => {
  it('folds constant data-driven size', () => {
    const { scene, ast } = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | fill-white size-[360 / 12]
      }
    `)
    const optimized = optimize(scene, ast)
    const node = optimized.renderNodes[0]
    expect(node.size).toMatchObject({ kind: 'constant', value: 30 })
  })

  it('folds constant data-driven opacity', () => {
    const { scene, ast } = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | fill-white opacity-[0.5 * 0.8]
      }
    `)
    const optimized = optimize(scene, ast)
    expect(optimized.renderNodes[0].opacity).toEqual({ kind: 'constant', value: 0.4 })
  })

  it('does not fold per-feature expressions', () => {
    const { scene, ast } = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | fill-white size-[speed * 2]
      }
    `)
    const optimized = optimize(scene, ast)
    expect(optimized.renderNodes[0].size.kind).toBe('data-driven')
    if (optimized.renderNodes[0].size.kind === 'data-driven') {
      expect(optimized.renderNodes[0].size.expr.classification).toBe('per-feature-gpu')
    }
  })

  it('passes through already-constant values unchanged', () => {
    const { scene, ast } = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | fill-red-500 opacity-80
      }
    `)
    const optimized = optimize(scene, ast)
    expect(optimized.renderNodes[0].fill.kind).toBe('constant')
    expect(optimized.renderNodes[0].opacity).toEqual({ kind: 'constant', value: 0.8 })
  })

  it('folds user-defined function calls', () => {
    const { scene, ast } = compile(`
      fn double(x: f32) -> f32 { x * 2 }

      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | fill-white size-[double(15)]
      }
    `)
    const optimized = optimize(scene, ast)
    expect(optimized.renderNodes[0].size).toMatchObject({ kind: 'constant', value: 30 })
  })
})
