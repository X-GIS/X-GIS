// ═══════════════════════════════════════════════════════════════════
// step() GPU lowering ↔ CPU evaluator parity (Mapbox N-stop form)
// ═══════════════════════════════════════════════════════════════════
//
// #2311: fnCallToNode lowered only the legacy `step(value, threshold, below,
// above)` select, so every Mapbox N-stop `step(input, default, s1, v1, …)` —
// the ONLY shape the converter emits (convert/expr-string.ts stepHandler) —
// was miscompiled on the GPU while the CPU evaluator
// (eval/evaluator-helpers.ts callBuiltin 'step') returned the right value.
//
// The invariant this pins: for any all-numeric step the GPU IR must evaluate
// to exactly what `evaluate` returns. Every value on the f32 GPU path is
// numeric, so the CPU authority always takes its N-stop branch there.

import { describe, expect, it } from 'vitest'
import { parseExpressionString } from '../parser/parser'
import { astToNode, exprToWGSL } from './wgsl-expr'
import { evaluate } from '../eval/evaluator'
import type { NodeLike } from './node-types'

type IRExpr = NodeLike<'f32'>['expr']

/** Minimal CPU interpreter over the f32 IR `astToNode` emits (lit / compare /
 *  select / binop / index into feat_data), so the assertion compares SEMANTICS
 *  rather than a WGSL spelling. feat_id is 0, so `index` reads `feat[slot]`. */
function run(e: IRExpr, feat: readonly number[]): number {
  const n = e as unknown as Record<string, unknown>
  switch (n.op) {
    case 'lit':
      return n.value as number
    case 'compare': {
      const a = run(n.a as IRExpr, feat)
      const b = run(n.b as IRExpr, feat)
      switch (n.cop) {
        case '<':
          return a < b ? 1 : 0
        case '<=':
          return a <= b ? 1 : 0
        case '>':
          return a > b ? 1 : 0
        case '>=':
          return a >= b ? 1 : 0
        case '==':
          return a === b ? 1 : 0
        case '!=':
          return a !== b ? 1 : 0
      }
      throw new Error(`cop ${String(n.cop)}`)
    }
    case 'select':
      return run(n.cond as IRExpr, feat)
        ? run(n.ifTrue as IRExpr, feat)
        : run(n.ifFalse as IRExpr, feat)
    case 'binop': {
      const a = run(n.a as IRExpr, feat)
      const b = run(n.b as IRExpr, feat)
      switch (n.bop) {
        case '+':
          return a + b
        case '-':
          return a - b
        case '*':
          return a * b
        case '/':
          return a / b
      }
      throw new Error(`bop ${String(n.bop)}`)
    }
    case 'index':
      return feat[run(n.idx as IRExpr, feat)]!
    case 'member':
      if (n.field === 'feat_id') return 0
      throw new Error(`member ${String(n.field)}`)
    default:
      throw new Error(`op ${String(n.op)}`)
  }
}

/** Assert GPU-IR ≡ CPU evaluator for one single-field step over a set of inputs. */
function expectParity(source: string, field: string, inputs: readonly number[]): void {
  const ast = parseExpressionString(source)
  const fieldMap = new Map([[field, 0]])
  const node = astToNode(ast, fieldMap)
  for (const x of inputs) {
    const cpu = evaluate(ast, { [field]: x }) as number
    const gpu = run(node.expr, [x])
    expect(
      gpu,
      `${field}=${x}: GPU ${gpu} vs CPU ${cpu} — wgsl: ${exprToWGSL(ast, fieldMap)}`,
    ).toBe(cpu)
  }
}

describe('step() GPU lowering vs CPU evaluator (Mapbox N-stop form)', () => {
  it('4-arg N-stop step(.rank, 1, 3, 0) — converter output for ["step",["get","rank"],1,3,0]', () => {
    expectParity('step(.rank, 1, 3, 0)', 'rank', [0, 0.5, 2, 3, 5])
  })

  it('6-arg N-stop step(.pop, 3, 100000, 5, 1000000, 7) keeps every stop', () => {
    expectParity('step(.pop, 3, 100000, 5, 1000000, 7)', 'pop', [0, 100000, 500000, 1000000, 5e6])
  })

  it('8-arg N-stop matches on every bucket boundary', () => {
    expectParity(
      'step(.pop_max, 2.5, 100000, 4, 1000000, 6, 5000000, 8)',
      'pop_max',
      [0, 99999, 100000, 999999, 1000000, 4999999, 5000000, 1e7],
    )
  })

  it('emits the default when no stop is reached, not the first stop x-value', () => {
    const ast = parseExpressionString('step(.rank, 1, 3, 0)')
    // The old lowering emitted `select(0.0, 3.0, feat < 1.0)` — the stop
    // x-value 3 as a payload. The N-stop chain must select on `>= 3.0`.
    expect(exprToWGSL(ast, new Map([['rank', 0]]))).toContain('>= 3.0')
  })
})
