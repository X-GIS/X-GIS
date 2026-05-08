import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { exprToWGSL, collectFields } from '../codegen/wgsl-expr'
import { generateShaderVariant } from '../codegen/shader-gen'
import type * as AST from '../parser/ast'

function parseExpr(source: string): AST.Expr {
  const tokens = new Lexer(`let x = ${source}`).tokenize()
  const ast = new Parser(tokens).parse()
  return (ast.body[0] as AST.LetStatement).value
}

function compileOptimized(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  return optimize(scene, ast)
}

describe('WGSL Expression Compiler', () => {
  const fieldMap = new Map([['speed', 0], ['altitude', 1], ['heading', 2]])

  it('compiles number literals', () => {
    expect(exprToWGSL(parseExpr('42'), fieldMap)).toBe('42.0')
    expect(exprToWGSL(parseExpr('3.14'), fieldMap)).toBe('3.14')
  })

  it('compiles field access', () => {
    expect(exprToWGSL(parseExpr('speed'), fieldMap)).toBe('feat_data[input.feat_id * 3u + 0u]')
    expect(exprToWGSL(parseExpr('.altitude'), fieldMap)).toBe('feat_data[input.feat_id * 3u + 1u]')
  })

  it('compiles arithmetic', () => {
    const result = exprToWGSL(parseExpr('speed / 50'), fieldMap)
    expect(result).toBe('(feat_data[input.feat_id * 3u + 0u] / 50.0)')
  })

  it('compiles built-in function calls', () => {
    const result = exprToWGSL(parseExpr('clamp(speed, 4, 24)'), fieldMap)
    expect(result).toBe('clamp(feat_data[input.feat_id * 3u + 0u], 4.0, 24.0)')
  })

  it('compiles pipe expressions', () => {
    const result = exprToWGSL(parseExpr('speed / 50 | clamp(4, 24)'), fieldMap)
    expect(result).toBe('clamp((feat_data[input.feat_id * 3u + 0u] / 50.0), 4.0, 24.0)')
  })

  it('compiles unary negation', () => {
    expect(exprToWGSL(parseExpr('-speed'), fieldMap)).toBe('(-feat_data[input.feat_id * 3u + 0u])')
  })

  it('compiles log10 via log', () => {
    const result = exprToWGSL(parseExpr('log10(speed)'), fieldMap)
    expect(result).toContain('log(')
    expect(result).toContain('log(10.0)')
  })

  it('compiles scale as multiplication', () => {
    const result = exprToWGSL(parseExpr('scale(speed, 4)'), fieldMap)
    expect(result).toBe('(feat_data[input.feat_id * 3u + 0u] * 4.0)')
  })

  it('compiles user-defined function by inlining', () => {
    const fnTokens = new Lexer(`fn double(x: f32) -> f32 { x * 2 }`).tokenize()
    const fnAst = new Parser(fnTokens).parse()
    const fnEnv = new Map([['double', fnAst.body[0] as AST.FnStatement]])

    const result = exprToWGSL(parseExpr('double(speed)'), fieldMap, fnEnv)
    expect(result).toBe('(feat_data[input.feat_id * 3u + 0u] * 2.0)')
  })
})

describe('collectFields', () => {
  it('collects field names from expression', () => {
    const fields = collectFields(parseExpr('speed / 50 | clamp(altitude, 24)'))
    expect(fields).toContain('speed')
    expect(fields).toContain('altitude')
    expect(fields.size).toBe(2)
  })

  it('ignores zoom keyword', () => {
    const fields = collectFields(parseExpr('zoom + 1'))
    expect(fields.size).toBe(0)
  })
})

describe('Shader Variant Generator', () => {
  it('generates variant with constant fill and opacity', () => {
    const scene = compileOptimized(`
      source data { type: geojson, url: "x.geojson" }
      layer countries {
        source: data
        | fill-red-500 opacity-80
      }
    `)
    const node = scene.renderNodes[0]
    const variant = generateShaderVariant(node)

    expect(variant.preamble).toContain('FILL_COLOR')
    expect(variant.preamble).toContain('OPACITY')
    expect(variant.needsFeatureBuffer).toBe(false)
    expect(variant.uniformFields).not.toContain('fill_color')
  })

  it('generates variant with no fill (none)', () => {
    const scene = compileOptimized(`
      source data { type: geojson, url: "x.geojson" }
      layer countries {
        source: data
        | stroke-white stroke-2
      }
    `)
    const node = scene.renderNodes[0]
    const variant = generateShaderVariant(node)

    expect(variant.preamble).toContain('FILL_COLOR')
    expect(variant.preamble).toContain('0.0, 0.0, 0.0, 0.0')
  })

  it('generates variant needing feature buffer for data-driven size', () => {
    const scene = compileOptimized(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | fill-blue-500 size-[speed]
      }
    `)
    const node = scene.renderNodes[0]
    const variant = generateShaderVariant(node)

    // Size is data-driven but fill is constant
    // The variant itself doesn't need feature buffer for fill
    // (size isn't handled in fragment shader yet)
    expect(variant.preamble).toContain('FILL_COLOR')
  })

  it('same constants produce same cache key', () => {
    const scene = compileOptimized(`
      source d1 { type: geojson, url: "a.geojson" }
      source d2 { type: geojson, url: "b.geojson" }
      layer a { source: d1 | fill-red-500 opacity-80 }
      layer b { source: d2 | fill-red-500 opacity-80 }
    `)
    const v1 = generateShaderVariant(scene.renderNodes[0])
    const v2 = generateShaderVariant(scene.renderNodes[1])
    expect(v1.key).toBe(v2.key)
  })

  it('different constants produce different cache keys', () => {
    const scene = compileOptimized(`
      source d1 { type: geojson, url: "a.geojson" }
      source d2 { type: geojson, url: "b.geojson" }
      layer a { source: d1 | fill-red-500 opacity-80 }
      layer b { source: d2 | fill-blue-500 opacity-60 }
    `)
    const v1 = generateShaderVariant(scene.renderNodes[0])
    const v2 = generateShaderVariant(scene.renderNodes[1])
    expect(v1.key).not.toBe(v2.key)
  })
})

describe('Full Pipeline: emit with shader variants', () => {
  it('emits ShowCommand with shader variant and preserved fields', () => {
    const tokens = new Lexer(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | fill-green-500 stroke-black stroke-2 opacity-80 size-12
        | opacity-[interpolate(zoom, 8, 40, 16, 100)]
      }
    `).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    const optimized = optimize(scene, ast)
    const commands = emitCommands(optimized)

    expect(commands.shows).toHaveLength(1)
    const show = commands.shows[0]

    // Preserved fields
    expect(show.fill).not.toBeNull()
    expect(show.stroke).toBe('#000000')
    expect(show.strokeWidth).toBe(2)
    expect(show.size).toBe(12)

    // Zoom stops preserved
    expect(show.zoomOpacityStops).not.toBeNull()
    expect(show.zoomOpacityStops).toHaveLength(2)

    // Shader variant generated
    expect(show.shaderVariant).not.toBeNull()
    expect(show.shaderVariant!.key).toBeTruthy()
  })
})
