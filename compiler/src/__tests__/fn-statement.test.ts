// ═══ User-defined `fn` (#1535) — reintroduction test corpus ═══
// Grows step-by-step with the feature: step 7 pins the lexer-keyword
// hazards (the documented `fn-*` utility-name trap), later steps add
// the statement grammar, name resolution, and the inline pass.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import type * as AST from '../parser/ast'
import { withPragma } from './_pragma'
import { lower } from '../ir/lower'
import { resolveImports } from '../module/resolver'
import { inlineUserFns } from '../ir/fn-inline'
import { evaluate } from '../eval/evaluator'
import { classifyExpr } from '../ir/classify'
import type { Diagnostic } from '../diagnostics/diagnostic'

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

describe('fn keyword — utility-name re-admission (#1535 step 7)', () => {
  // The documented keyword trap: a keyword usable inside a hyphen-joined
  // utility name must be re-admitted in isUtilityNameToken AND the
  // mid-name continuation list, or the name accumulator short-circuits.
  // (`preset`/`from`/`to` already live there for the same reason.)
  it('a leading `fn-` utility name still parses after fn became a keyword', () => {
    const items = layerItems(`
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | fn-foo-2 opacity-80 }
`)
    expect(items.map((i) => i.name)).toEqual(['fn-foo-2', 'opacity-80'])
  })

  it('a mid-name `-fn-` segment still parses', () => {
    const items = layerItems(`
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | shape-fn-star }
`)
    expect(items.map((i) => i.name)).toEqual(['shape-fn-star'])
  })
})

describe('fn statement grammar (#1535 step 8)', () => {
  function firstFn(source: string): AST.FnStatement {
    const stmt = parse(source).body.find((s) => s.kind === 'FnStatement')
    if (!stmt) throw new Error('no FnStatement parsed')
    return stmt as AST.FnStatement
  }

  it('parses an expression-bodied fn declaration', () => {
    const f = firstFn('fn halo(width, base) { return clamp(width * 1.5 + base, 1, 24) }')
    expect(f.name).toBe('halo')
    expect(f.params).toEqual(['width', 'base'])
    expect(f.body).toMatchObject({ kind: 'FnCall', callee: { name: 'clamp' } })
  })

  it('parses a zero-param fn', () => {
    const f = firstFn('fn tau() { return PI() * 2 }')
    expect(f.params).toEqual([])
  })

  it('ternary bodies parse (the v1 branching form)', () => {
    const f = firstFn('fn pick(x) { return x > 10 ? 1 : 0 }')
    expect(f.body.kind).toBe('ConditionalExpr')
  })

  it('imperative bodies are rejected (pre-#1072 grammar stays dead)', () => {
    expect(() => parse('fn scale(x) { let y = x * 2 return y }')).toThrow()
  })

  it('a body without return is rejected', () => {
    expect(() => parse('fn scale(x) { x * 2 }')).toThrow()
  })
})

describe('fn name resolution (#1535 step 9)', () => {
  it('a declared fn is a legal callee in a binding (no X-GIS0012)', () => {
    const scene = lower(
      parse(`
fn halo(width, base) { return clamp(width * 1.5 + base, 1, 24) }
source w { type: geojson, url: "w.geojson" }
layer roads {
  source: w
  | stroke-[halo(.width, 2)]
}
`),
    )
    const errors = (scene.diagnostics ?? []).filter((d) => d.code === 'X-GIS0012')
    expect(errors).toHaveLength(0)
  })

  it('an unknown callee inside an fn BODY is still X-GIS0012', () => {
    const scene = lower(
      parse(`
fn halo(width) { return sqrrt(width) }
source w { type: geojson, url: "w.geojson" }
layer roads { source: w  | stroke-[halo(.width)] }
`),
    )
    const errors = (scene.diagnostics ?? []).filter((d) => d.code === 'X-GIS0012')
    expect(errors).toHaveLength(1)
    // The flagged callee must be the body's `sqrrt`, not the declared fn.
    expect(errors[0]!.message).toContain('sqrrt')
  })

  it('two fns with the same name across imports collide (definitionName)', () => {
    const files: Record<string, string> = {
      './a.xgis': withPragma('fn halo(w) { return w }'),
      './b.xgis': withPragma('fn halo(w) { return w * 2 }'),
    }
    expect(() =>
      resolveImports(parse(`import "./a.xgis"\nimport "./b.xgis"`), './', (p) => files[p] ?? null),
    ).toThrow(/Duplicate top-level name "halo"/)
  })

  it('fns are cherry-pickable by name', () => {
    const files: Record<string, string> = {
      './lib.xgis': withPragma('fn halo(w) { return w }\nfn other(x) { return x }'),
    }
    const resolved = resolveImports(
      parse(`import { halo } from "./lib.xgis"`),
      './',
      (p) => files[p] ?? null,
    )
    const fns = resolved.body.filter((s) => s.kind === 'FnStatement') as AST.FnStatement[]
    expect(fns.map((f) => f.name)).toEqual(['halo'])
  })
})

describe('fn inline pass (#1535 step 10)', () => {
  function inlineBinding(source: string): AST.Expr {
    const diagnostics: Diagnostic[] = []
    const program = inlineUserFns(parse(source), diagnostics)
    if (diagnostics.length > 0) {
      throw new Error(`unexpected diagnostics: ${diagnostics.map((d) => d.message).join('; ')}`)
    }
    const layer = program.body.find((s) => s.kind === 'LayerStatement') as AST.LayerStatement
    const binding = layer.utilities.flatMap((l) => l.items).find((i) => i.binding)?.binding
    if (!binding) throw new Error('no bound utility item found')
    return binding
  }

  function inlineDiagnostics(source: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = []
    inlineUserFns(parse(source), diagnostics)
    return diagnostics
  }

  const SCENE = (fnDecls: string, binding: string) => `
${fnDecls}
source w { type: geojson, url: "w.geojson" }
layer roads {
  source: w
  | stroke-[${binding}]
}
`

  it('rewrites a user-fn call into its substituted body', () => {
    const b = inlineBinding(
      SCENE('fn halo(width, base) { return clamp(width * 1.5 + base, 1, 24) }', 'halo(.width, 2)'),
    )
    // clamp((.width * 1.5) + 2, 1, 24) — no user-fn call survives.
    expect(b).toMatchObject({ kind: 'FnCall', callee: { name: 'clamp' } })
    const first = (b as AST.FnCall).args[0]!
    expect(first).toMatchObject({
      kind: 'BinaryExpr',
      op: '+',
      right: { kind: 'NumberLiteral', value: 2 },
    })
  })

  it('the rewritten expression evaluates correctly on the CPU path', () => {
    const b = inlineBinding(
      SCENE('fn halo(width, base) { return clamp(width * 1.5 + base, 1, 24) }', 'halo(.width, 2)'),
    )
    expect(evaluate(b, { width: 10 })).toBe(17)
    expect(evaluate(b, { width: 100 })).toBe(24)
  })

  it('a GPU-safe fn body classifies per-feature-gpu — never a silent CPU demotion', () => {
    const b = inlineBinding(
      SCENE('fn halo(width, base) { return clamp(width * 1.5 + base, 1, 24) }', 'halo(.width, 2)'),
    )
    expect(classifyExpr(b)).toBe('per-feature-gpu')
  })

  it('a fn calling a CPU-only builtin classifies per-feature-cpu', () => {
    const b = inlineBinding(SCENE('fn tag(name) { return concat(name, "!") }', 'tag(.name)'))
    expect(classifyExpr(b)).toBe('per-feature-cpu')
  })

  it('fn-calls-fn resolves through nesting', () => {
    const b = inlineBinding(
      SCENE(
        'fn double(x) { return x * 2 }\nfn quad(x) { return double(double(x)) }',
        'quad(.width)',
      ),
    )
    expect(evaluate(b, { width: 3 })).toBe(12)
  })

  it('zoom stays a legal bare identifier inside a body', () => {
    const diags = inlineDiagnostics(SCENE('fn fade(x) { return x * zoom }', 'fade(.width)'))
    expect(diags).toHaveLength(0)
  })

  it('self-recursion is X-GIS0015', () => {
    const diags = inlineDiagnostics(SCENE('fn loop(x) { return loop(x) }', 'loop(.width)'))
    expect(diags.some((d) => d.code === 'X-GIS0015')).toBe(true)
  })

  it('mutual recursion is X-GIS0015', () => {
    const diags = inlineDiagnostics(
      SCENE('fn a(x) { return b(x) }\nfn b(x) { return a(x) }', 'a(.width)'),
    )
    expect(diags.some((d) => d.code === 'X-GIS0015')).toBe(true)
  })

  it('wrong arity is X-GIS0016 at the call site', () => {
    const diags = inlineDiagnostics(SCENE('fn halo(a, b) { return a + b }', 'halo(.width)'))
    expect(diags.some((d) => d.code === 'X-GIS0016' && d.severity === 'error')).toBe(true)
  })

  it('a non-param bare identifier in a body is X-GIS0017', () => {
    const diags = inlineDiagnostics(SCENE('fn bad(x) { return x + speed }', 'bad(.width)'))
    expect(diags.some((d) => d.code === 'X-GIS0017')).toBe(true)
  })

  it('lower() end-to-end: fn scene lowers with zero error diagnostics', () => {
    const scene = lower(
      parse(
        SCENE(
          'fn halo(width, base) { return clamp(width * 1.5 + base, 1, 24) }',
          'halo(.width, 2)',
        ),
      ),
    )
    expect((scene.diagnostics ?? []).filter((d) => d.severity === 'error')).toHaveLength(0)
  })
})
