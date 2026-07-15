import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { classifyExpr } from '../ir/classify'
import { constFold } from '../ir/const-fold'
import type * as AST from '../parser/ast'
import { withPragma } from './_pragma'
import { parseExpressionString } from '../parser/parser'

function parseExpr(source: string): AST.Expr {
  return parseExpressionString(source)
}

function compile(source: string) {
  const tokens = new Lexer(withPragma(source)).tokenize()
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
})

describe('Optimize Pass', () => {
  it('folds constant data-driven size', () => {
    const { scene } = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | fill-white size-[360 / 12]
      }
    `)
    const optimized = optimize(scene)
    const node = optimized.renderNodes[0]
    expect(node.size).toMatchObject({ kind: 'constant', value: 30 })
  })

  it('folds constant data-driven opacity', () => {
    const { scene } = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | fill-white opacity-[0.5 * 0.8]
      }
    `)
    const optimized = optimize(scene)
    expect(optimized.renderNodes[0].opacity).toEqual({ kind: 'constant', value: 0.4 })
  })

  it('does not fold per-feature expressions', () => {
    const { scene } = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | fill-white size-[speed * 2]
      }
    `)
    const optimized = optimize(scene)
    expect(optimized.renderNodes[0].size.kind).toBe('data-driven')
    if (optimized.renderNodes[0].size.kind === 'data-driven') {
      expect(optimized.renderNodes[0].size.expr.classification).toBe('per-feature-gpu')
    }
  })

  it('passes through already-constant values unchanged', () => {
    const { scene } = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | fill-red-500 opacity-80
      }
    `)
    const optimized = optimize(scene)
    expect(optimized.renderNodes[0].fill.kind).toBe('constant')
    expect(optimized.renderNodes[0].opacity).toEqual({ kind: 'constant', value: 0.8 })
  })
})
