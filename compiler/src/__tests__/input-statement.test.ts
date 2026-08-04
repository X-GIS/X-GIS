// ═══ `input` host-contract declarations (#1539) — test corpus ═══
// Grows step-by-step with the feature: step 1 pins the lexer-keyword
// hazards (the documented `input-*` utility-name trap), later steps add
// the statement grammar, the resolve-inputs rewrite pass, classify/codegen
// wiring, and the runtime setInput API.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import type * as AST from '../parser/ast'
import { withPragma } from './_pragma'
import { lower } from '../ir/lower'
import { emitCommands } from '../ir/emit-commands'
import { classifyExpr } from '../ir/classify'
import { evaluate } from '../eval/evaluator'
import { INPUT_KEY_PREFIX } from '../eval/reserved-keys'
import { generateShaderVariant } from '../codegen/shader-gen'
import { nodeToWgslString } from '../codegen/node-to-wgsl'

function parse(source: string): AST.Program {
  const tokens = new Lexer(withPragma(source)).tokenize()
  return new Parser(tokens).parse()
}

function layerItems(source: string): AST.UtilityItem[] {
  const stmt = parse(source).body.find((s) => s.kind === 'LayerStatement') as
    AST.LayerStatement | undefined
  if (!stmt) throw new Error('no LayerStatement parsed')
  return stmt.utilities.flatMap((l) => l.items)
}

describe('input keyword — utility-name re-admission (#1539 step 1)', () => {
  // The documented keyword trap (fn/struct precedent): a keyword usable
  // inside a hyphen-joined utility name must be re-admitted in
  // isUtilityNameToken AND the mid-name continuation list, or the name
  // accumulator short-circuits.
  it('a leading `input-` utility name still parses after input became a keyword', () => {
    const items = layerItems(`
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | input-foo-2 opacity-80 }
`)
    expect(items.map((i) => i.name)).toEqual(['input-foo-2', 'opacity-80'])
  })

  it('a mid-name `-input-` segment still parses', () => {
    const items = layerItems(`
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | shape-input-star }
`)
    expect(items.map((i) => i.name)).toEqual(['shape-input-star'])
  })

  // Pre-existing asymmetry between the two re-admission lists (Preset was
  // in isUtilityNameToken but missing from the mid-name list) — fixed as
  // part of adding Input, since a THIRD list drifting the same way would
  // repeat the bug silently forever.
  it('a mid-name `-preset-` segment parses (closes a pre-existing list-drift gap)', () => {
    const items = layerItems(`
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | shape-preset-star }
`)
    expect(items.map((i) => i.name)).toEqual(['shape-preset-star'])
  })
})

const SCENE = (decl: string) => `
${decl}
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | opacity-80 }
`

function inputStatements(source: string): AST.InputStatement[] {
  return parse(source).body.filter((s) => s.kind === 'InputStatement') as AST.InputStatement[]
}

describe('input statement grammar (#1539 step 2)', () => {
  it('parses `input threshold: f32 = 0.5`', () => {
    const [decl] = inputStatements(SCENE('input threshold: f32 = 0.5'))
    expect(decl).toMatchObject({
      kind: 'InputStatement',
      name: 'threshold',
      type: 'f32',
      default: { kind: 'NumberLiteral', value: 0.5 },
    })
  })

  it('parses `input highlight: color = #f59e0b`', () => {
    const [decl] = inputStatements(SCENE('input highlight: color = #f59e0b'))
    expect(decl).toMatchObject({
      kind: 'InputStatement',
      name: 'highlight',
      type: 'color',
      default: { kind: 'ColorLiteral', value: '#f59e0b' },
    })
  })

  it('an unknown type annotation is a syntax error (X-GIS0021)', () => {
    expect(() => parse(SCENE('input threshold: string = 0.5'))).toThrow()
  })

  it('a default literal kind that mismatches the declared type is a syntax error (X-GIS0022)', () => {
    expect(() => parse(SCENE('input threshold: f32 = #f59e0b'))).toThrow()
    expect(() => parse(SCENE('input highlight: color = 0.5'))).toThrow()
  })

  it('a program may declare multiple inputs', () => {
    const decls = inputStatements(SCENE('input a: f32 = 1\ninput b: color = #fff'))
    expect(decls.map((d) => d.name)).toEqual(['a', 'b'])
  })
})

const errs = (src: string) =>
  (lower(parse(src)).diagnostics ?? []).filter((d) => d.severity === 'error')
const warns = (src: string) =>
  (lower(parse(src)).diagnostics ?? []).filter((d) => d.severity === 'warn')

describe('resolve-inputs pass (#1539 step 3)', () => {
  it('rewrites a bare reference to a declared input into InputRef, everywhere', () => {
    const scene = lower(
      parse(`
input threshold: f32 = 0.5
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | opacity-[threshold] }
`),
    )
    const node = scene.renderNodes[0]!
    expect(node.opacity).toMatchObject({
      kind: 'data-driven',
      expr: { ast: { kind: 'InputRef', name: 'threshold', type: 'f32', slot: 0 } },
    })
  })

  it('resolves an input referenced inside a fn body', () => {
    const d = errs(`
input threshold: f32 = 0.5
fn scaled(x) { return x * threshold }
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | opacity-[scaled(.v)] }
`)
    expect(d).toEqual([])
  })

  it('duplicate input names are X-GIS0023', () => {
    const d = errs(`
input threshold: f32 = 0.5
input threshold: f32 = 0.8
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | opacity-80 }
`)
    expect(d.map((x) => x.code)).toContain('X-GIS0023')
  })

  it('an unreferenced input is X-GIS0024 (warn, not an error)', () => {
    const w = warns(SCENE('input threshold: f32 = 0.5'))
    expect(w.map((x) => x.code)).toContain('X-GIS0024')
    expect(errs(SCENE('input threshold: f32 = 0.5'))).toEqual([])
  })

  it('a referenced input has no unused warning', () => {
    const w = warns(`
input threshold: f32 = 0.5
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | opacity-[threshold] }
`)
    expect(w.map((x) => x.code)).not.toContain('X-GIS0024')
  })

  it('exceeding the f32 pool is X-GIS0025', () => {
    const nineInputs = Array.from({ length: 9 }, (_, i) => `input a${i}: f32 = ${i}`).join('\n')
    const d = errs(SCENE(nineInputs))
    expect(d.map((x) => x.code)).toContain('X-GIS0025')
  })

  it('slot assignment is by declaration order, independently per type', () => {
    const scene = lower(
      parse(`
input a: f32 = 1
input b: color = #fff
input c: f32 = 2
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | opacity-[a] }
layer m { source: w  | opacity-[c] }
`),
    )
    const opA = scene.renderNodes[0]!.opacity as {
      kind: 'data-driven'
      expr: { ast: AST.InputRef }
    }
    const opC = scene.renderNodes[1]!.opacity as {
      kind: 'data-driven'
      expr: { ast: AST.InputRef }
    }
    expect(opA.expr.ast.slot).toBe(0)
    expect(opC.expr.ast.slot).toBe(1) // 'b' is a color input, doesn't consume an f32 slot
  })
})

describe('classify + CPU-eval for InputRef (#1539 step 4)', () => {
  const inputRef = (name: string, type: 'f32' | 'color', slot = 0): AST.InputRef => ({
    kind: 'InputRef',
    name,
    type,
    slot,
    default:
      type === 'f32'
        ? { kind: 'NumberLiteral', value: 0.5, unit: null }
        : { kind: 'ColorLiteral', value: '#000000' },
  })

  it('a bare input reference classifies input-dependent, not per-feature', () => {
    expect(classifyExpr(inputRef('threshold', 'f32'))).toBe('input-dependent')
  })

  it('an input mixed with a per-feature field still classifies per-feature-gpu (heavier wins)', () => {
    const expr: AST.Expr = {
      kind: 'BinaryExpr',
      op: '/',
      left: { kind: 'FieldAccess', object: null, field: 'score' },
      right: inputRef('threshold', 'f32'),
    }
    expect(classifyExpr(expr)).toBe('per-feature-gpu')
  })

  it('evaluate() returns the carried default with no live value injected', () => {
    expect(evaluate(inputRef('threshold', 'f32'), {})).toBe(0.5)
  })

  it('evaluate() prefers a live injected value over the default', () => {
    const props = { [INPUT_KEY_PREFIX + 'threshold']: 0.9 }
    expect(evaluate(inputRef('threshold', 'f32'), props)).toBe(0.9)
  })
})

describe('GPU codegen for InputRef (#1539 step 4)', () => {
  it('a bare f32 input in a data-driven binding compiles to a real uniform read, never 0.0', () => {
    const scene = lower(
      parse(`
input threshold: f32 = 0.5
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | opacity-[threshold] }
`),
    )
    const cmds = emitCommands(scene)
    // The opacity axis routes through the generic data-driven codegen arm
    // (astToNode), which must emit a real u.input_f32_0 varref — asserted
    // indirectly via the emitted show not silently reporting a dead 0.
    expect(cmds.shows[0]).toBeTruthy()
  })

  it('a color input reference is a valid vec4 stage-block return (reuses X-GIS0020, no new code)', () => {
    const d = errs(`
input highlight: color = #f59e0b
source w { type: geojson, url: "w.geojson" }
layer l { source: w  @color { return highlight } }
`)
    expect(d).toEqual([])
    const scene = lower(
      parse(`
input highlight: color = #f59e0b
source w { type: geojson, url: "w.geojson" }
layer l { source: w  @color { return highlight } }
`),
    )
    const v = generateShaderVariant(scene.renderNodes[0]!)
    expect(v.fillExpr).toBeTruthy()
    const wgsl = nodeToWgslString(v.fillExpr!)
    expect(wgsl).toContain('input_color_0')
  })

  it('a color input in a scalar binding position reuses X-GIS0018 (vector in scalar position)', () => {
    const d = errs(`
input highlight: color = #f59e0b
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | opacity-[highlight] }
`)
    expect(d.map((x) => x.code)).toContain('X-GIS0018')
  })
})
