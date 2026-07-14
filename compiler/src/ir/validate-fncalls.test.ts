// ═══ Unknown-function validation (#1066) ═══
//
// `callBuiltin`'s old default branch returned `args[0]` for ANY unknown
// callee, so `sqrrt(.x)` silently evaluated to `.x`. Lower now rejects
// unknown callees as `X-GIS0012` errors (ir/validate-fncalls.ts) and
// callBuiltin's default throws as defense-in-depth. These tests pin the
// fail-before behaviour, prove the valid set is driven from the actual
// registries (no hand-copied list), and guard the set↔switch consistency.

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from './lower'
import { validateFnCalls, NON_BUILTIN_CALLEES } from './validate-fncalls'
import { GPU_SAFE_BUILTINS } from './classify'
import { BUILTIN_FN_NAMES, callBuiltin } from '../eval/evaluator-helpers'
import { UNKNOWN_FUNCTION, type Diagnostic } from '../diagnostics/diagnostic'
import type * as AST from '../parser/ast'
import { withPragma } from '../__tests__/_pragma'

const parse = (src: string): AST.Program =>
  new Parser(new Lexer(withPragma(src)).tokenize()).parse()

/** X-GIS0012 diagnostics from lowering `src`. */
const unknownFnDiags = (src: string): Diagnostic[] =>
  (lower(parse(src)).diagnostics ?? []).filter((d) => d.code === UNKNOWN_FUNCTION)

/** A synthetic program that calls each name once — bypasses the parser so
 *  the registry-driven test can exercise every set member (including the
 *  hyphenated aliases the identifier grammar can't spell). */
const callProgram = (names: readonly string[]): AST.Program => ({
  kind: 'Program',
  body: names.map((name, i): AST.Statement => ({
    kind: 'ExprStatement',
    line: i + 1,
    expr: {
      kind: 'FnCall',
      callee: { kind: 'Identifier', name },
      args: [{ kind: 'FieldAccess', object: null, field: 'x' }],
    },
  })),
})

describe('lower rejects unknown function callees — X-GIS0012 (#1066)', () => {
  it('FAIL-BEFORE: `sqrrt(.pop)` lowers with an error naming it and suggesting `sqrt`', () => {
    const diags = unknownFnDiags(`
source p { type: geojson, url: "x.geojson" }
layer d {
  source: p
  | size-[sqrrt(.pop) / 2]
}`)
    expect(diags).toHaveLength(1)
    expect(diags[0].severity).toBe('error')
    expect(diags[0].code).toBe('X-GIS0012')
    expect(diags[0].message).toContain('sqrrt')
    expect(diags[0].help).toContain('sqrt')
  })

  it('the valid sibling `sqrt(.pop)` produces NO unknown-function error (non-vacuous)', () => {
    expect(
      unknownFnDiags(`
source p { type: geojson, url: "x.geojson" }
layer d {
  source: p
  | size-[sqrt(.pop) / 2]
}`),
    ).toHaveLength(0)
  })

  it('the diagnostic span carries the offending utility line + col 1', () => {
    // withPragma reuses the leading blank line, so the `| size-[…]` row is
    // line 5 of the padded source.
    const diags = unknownFnDiags(`
source p { type: geojson, url: "x.geojson" }
layer d {
  source: p
  | size-[sqrrt(.pop)]
}`)
    expect(diags[0].span).toMatchObject({ line: 5, col: 1 })
  })

  it('a user-declared `fn` resolves without an unknown-function error', () => {
    expect(
      unknownFnDiags(`
fn dbl(v: f32) -> f32 { v * 2 }
source p { type: geojson, url: "x.geojson" }
layer d {
  source: p
  | size-[dbl(.pop)]
}`),
    ).toHaveLength(0)
  })
})

describe('valid callees are driven from the registries — single authority (#1066)', () => {
  it('every builtin + alias + non-builtin special form passes validation', () => {
    const all = [...BUILTIN_FN_NAMES, ...NON_BUILTIN_CALLEES]
    const diags: Diagnostic[] = []
    validateFnCalls(callProgram(all), diags)
    expect(diags.filter((d) => d.code === UNKNOWN_FUNCTION)).toEqual([])
  })

  it('clearly-unknown names ARE flagged (guards the pass-through test against vacuity)', () => {
    const diags: Diagnostic[] = []
    validateFnCalls(callProgram(['sqrrt', 'clampp', 'notafunction']), diags)
    expect(diags.filter((d) => d.code === UNKNOWN_FUNCTION)).toHaveLength(3)
  })
})

describe('callBuiltin defense-in-depth + set↔switch consistency (#1066)', () => {
  it('throws for an unknown name instead of silently returning args[0]', () => {
    expect(() => callBuiltin('sqrrt', [42])).toThrow(/unknown function/)
    // Pre-#1066 this returned 42 (args[0]); assert it no longer does.
    expect(() => callBuiltin('sqrrt', [42])).toThrow()
  })

  it('no BUILTIN_FN_NAMES entry reaches the throwing default (set ⊆ switch)', () => {
    for (const name of BUILTIN_FN_NAMES) {
      try {
        callBuiltin(name, [1, 2, 3])
      } catch (e) {
        // A handled builtin may still throw on hostile args, but it must
        // NOT be the "unknown function" default — that would mean the name
        // is in the set but missing from the switch.
        expect((e as Error).message).not.toContain('unknown function')
      }
    }
  })

  it('GPU_SAFE_BUILTINS ⊆ BUILTIN_FN_NAMES — every GPU-safe builtin is CPU-evaluable', () => {
    for (const name of GPU_SAFE_BUILTINS) {
      expect(BUILTIN_FN_NAMES.has(name)).toBe(true)
    }
  })
})
