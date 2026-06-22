import { describe, it, expect } from 'vitest'
import { lint, type LintRule } from './engine'
import { RULES } from './rules'
import { module, fn, f32T, f32 } from '../../ir'

// A throwaway rule, to prove adding one is trivial (write a LintRule, run it).
const noUpperFnName: LintRule = {
  id: 'no-upper-fn-name',
  description: 'fn names should be lower-case',
  severity: 'warning',
  create: (ctx) => ({
    Func(f) {
      if (/[A-Z]/.test(f.name)) ctx.report(`fn '${f.name}' has an upper-case letter`, { fn: f.name })
    },
  }),
}

describe('lint engine — scalable rule framework', () => {
  it('dispatches a custom rule and reports a diagnostic', () => {
    const m = module({ funcs: [fn('Bad', {}, f32T, () => f32(0)), fn('good', {}, f32T, () => f32(0))] })
    const diags = lint(m, [noUpperFnName])
    expect(diags).toHaveLength(1)
    expect(diags[0]).toMatchObject({ ruleId: 'no-upper-fn-name', severity: 'warning', fn: 'Bad' })
  })

  it('severity config can turn a rule off', () => {
    const m = module({ funcs: [fn('Bad', {}, f32T, () => f32(0))] })
    expect(lint(m, [noUpperFnName], { severity: { 'no-upper-fn-name': 'off' } })).toEqual([])
  })

  it('an Expr-only rule needs no traversal of its own (the engine walks once)', () => {
    let exprVisits = 0
    const counter: LintRule = {
      id: 'count', description: '', severity: 'warning', create: () => ({ Expr() { exprVisits++ } }),
    }
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, (_b, { x }) => x.mul(2).add(1))] })
    lint(m, [counter])
    expect(exprVisits).toBeGreaterThan(0) // x, 2, x*2, 1, (x*2)+1 … all visited
  })

  it('the production registry holds the wired rules (append to scale)', () => {
    const ids = RULES.map((r) => r.id)
    expect(ids).toContain('single-exit')
    expect(ids).toContain('mixed-scalar')
    expect(ids).toContain('binding-collision')
  })
})
