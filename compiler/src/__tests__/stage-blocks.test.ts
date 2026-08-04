// ═══ Shader stage blocks (#1538) — the Level-4 escape hatch ═══
//
// `@color { return <vec4 expr> }` on a layer authors the fragment colour
// directly. It lowers to shader-dsl IR (never WGSL text), landing in the
// SAME `ShaderVariant.fillExpr` slot a data-driven colour already fills —
// so the composer, the GLSL backend, lint, and reflection all keep working.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import type * as AST from '../parser/ast'
import { withPragma } from './_pragma'
import { lower } from '../ir/lower'
import { generateShaderVariant } from '../codegen/shader-gen'
import { nodeToWgslString } from '../codegen/node-to-wgsl'
import { emitCommands } from '../ir/emit-commands'

function parse(source: string): AST.Program {
  return new Parser(new Lexer(withPragma(source)).tokenize()).parse()
}

const SCENE = (block: string, extra = '') => `
${extra}
source w { type: geojson, url: "w.geojson" }
layer l {
  source: w
  ${block}
}
`

const errs = (src: string) =>
  (lower(parse(src)).diagnostics ?? []).filter((d) => d.severity === 'error')

describe('stage block grammar (#1538)', () => {
  it('parses `@color { return … }` into the layer', () => {
    const layer = parse(SCENE('@color { return vec4(1, 0, 0, 1) }')).body.find(
      (s) => s.kind === 'LayerStatement',
    ) as AST.LayerStatement
    expect(layer.stages).toHaveLength(1)
    expect(layer.stages![0]!.stage).toBe('color')
    expect(layer.stages![0]!.body).toMatchObject({ kind: 'FnCall', callee: { name: 'vec4' } })
  })

  it('parses `@stroke` as the symmetric stage', () => {
    const layer = parse(SCENE('@stroke { return vec4(0, 0, 1, 1) }')).body.find(
      (s) => s.kind === 'LayerStatement',
    ) as AST.LayerStatement
    expect(layer.stages![0]!.stage).toBe('stroke')
  })

  it('a layer may declare both stages, and keep ordinary utilities', () => {
    const layer = parse(
      SCENE(
        '@color { return vec4(1, 0, 0, 1) }\n  @stroke { return vec4(0, 0, 1, 1) }\n  | size-8',
      ),
    ).body.find((s) => s.kind === 'LayerStatement') as AST.LayerStatement
    expect(layer.stages!.map((s) => s.stage)).toEqual(['color', 'stroke'])
    expect(layer.utilities.flatMap((l) => l.items).map((i) => i.name)).toEqual(['size-8'])
  })

  it('an unknown stage name is a syntax error', () => {
    expect(() => parse(SCENE('@bogus { return vec4(1, 0, 0, 1) }'))).toThrow()
  })

  it('a body without `return` is a syntax error (expression-bodied, like fn)', () => {
    expect(() => parse(SCENE('@color { vec4(1, 0, 0, 1) }'))).toThrow()
  })
})

describe('stage block lowering (#1538)', () => {
  it('emits the authored expression as the variant fill expression', () => {
    const scene = lower(parse(SCENE('@color { return vec4(.r, 0.5, 0, 1) }')))
    expect(scene.diagnostics?.filter((d) => d.severity === 'error')).toEqual([])
    const v = generateShaderVariant(scene.renderNodes[0]!)
    expect(v.fillExpr).toBeTruthy()
    const wgsl = nodeToWgslString(v.fillExpr!)
    expect(wgsl).toContain('vec4')
    // The authored feature read survives into the shader body.
    expect(wgsl).toContain('feat_data')
  })

  it('@stroke fills the stroke slot, leaving fill on its default', () => {
    const scene = lower(parse(SCENE('@stroke { return vec4(0, 0, 1, 1) }')))
    const v = generateShaderVariant(scene.renderNodes[0]!)
    expect(nodeToWgslString(v.strokeExpr!)).toContain('vec4')
  })

  it('a user fn is usable inside a stage block (inlined before lowering)', () => {
    const scene = lower(
      parse(
        SCENE('@color { return vec4(tint(.r), 0, 0, 1) }', 'fn tint(x) { return clamp(x, 0, 1) }'),
      ),
    )
    expect(scene.diagnostics?.filter((d) => d.severity === 'error')).toEqual([])
    const wgsl = nodeToWgslString(generateShaderVariant(scene.renderNodes[0]!).fillExpr!)
    expect(wgsl).toContain('clamp')
  })

  it('two layers with different stage bodies get distinct variant keys', () => {
    const scene = lower(
      parse(`
source w { type: geojson, url: "w.geojson" }
layer a { source: w  @color { return vec4(.r, 0, 0, 1) } }
layer b { source: w  @color { return vec4(0, .r, 0, 1) } }
`),
    )
    const [va, vb] = scene.renderNodes.map((n) => generateShaderVariant(n))
    expect(va!.key).not.toBe(vb!.key)
  })
})

describe('stage block return type is checked (#1538)', () => {
  it('a scalar body is X-GIS0020, not a wrong-typed shader', () => {
    const d = errs(SCENE('@color { return .r * 2 }'))
    expect(d.map((x) => x.code)).toContain('X-GIS0020')
  })

  it('a vec3 body is X-GIS0020 — the slot is vec4', () => {
    expect(errs(SCENE('@color { return vec3(1, 0, 0) }')).map((x) => x.code)).toContain('X-GIS0020')
  })

  it('a vec4 body is accepted', () => {
    expect(errs(SCENE('@color { return vec4(1, 0, 0, 1) }'))).toEqual([])
  })
})

describe('stage block CPU colour fold (#1538 placeholder fix)', () => {
  it('a compile-time-constant @color body reports its real hex, not the white placeholder', () => {
    const cmds = emitCommands(lower(parse(SCENE('@color { return vec4(0.8, 0.4, 0.2, 1) }'))))
    expect(cmds.shows[0]!.fill).not.toBe('#ffffffff')
    expect(cmds.shows[0]!.fill).toBe('#cc6633') // 0.8*255=204=cc, 0.4*255=102=66, 0.2*255=51=33
  })

  it('a data-driven @color body keeps the opaque-white CPU placeholder', () => {
    const cmds = emitCommands(lower(parse(SCENE('@color { return vec4(.r, 0, 0, 1) }'))))
    expect(cmds.shows[0]!.fill).toBe('#ffffffff')
  })

  it('paintShapes.fill.fill mirrors the same constant/placeholder split', () => {
    const constShow = emitCommands(lower(parse(SCENE('@color { return vec4(1, 0, 0, 1) }'))))
      .shows[0]!
    expect(constShow.paintShapes.fill.fill).toMatchObject({ kind: 'constant', value: [1, 0, 0, 1] })

    const dataShow = emitCommands(lower(parse(SCENE('@color { return vec4(.r, 0, 0, 1) }'))))
      .shows[0]!
    expect(dataShow.paintShapes.fill.fill).toMatchObject({
      kind: 'constant',
      value: [1, 1, 1, 1],
    })
  })
})
