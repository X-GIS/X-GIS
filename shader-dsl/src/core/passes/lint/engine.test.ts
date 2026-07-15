import { describe, it, expect } from 'vitest'
import { lint, formatDiagnostics, summarize, unusedDeviations, type LintRule } from './engine'
import { RULES } from './rules'
import { STRICT, LENIENT } from './presets'
import { module, fn, externFn, f32T, f32 } from '../../ir'

const wide7 = () =>
  module({
    funcs: [
      fn(
        'wide',
        { a: f32T, b: f32T, c: f32T, d: f32T, e: f32T, g: f32T, h: f32T },
        f32T,
        ({ a }, _b) => a,
      ),
    ],
  })

// A throwaway rule, to prove adding one is trivial (write a LintRule, run it).
const noUpperFnName: LintRule = {
  id: 'no-upper-fn-name',
  description: 'fn names should be lower-case',
  severity: 'warning',
  create: (ctx) => ({
    Func(f) {
      if (/[A-Z]/.test(f.name))
        ctx.report(`fn '${f.name}' has an upper-case letter`, { fn: f.name })
    },
  }),
}

describe('lint engine — scalable rule framework', () => {
  it('dispatches a custom rule and reports a diagnostic', () => {
    const m = module({
      funcs: [fn('Bad', {}, f32T, () => f32(0)), fn('good', {}, f32T, () => f32(0))],
    })
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
      id: 'count',
      description: '',
      severity: 'warning',
      create: () => ({
        Expr() {
          exprVisits++
        },
      }),
    }
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, ({ x }, _b) => x.mul(2).add(1))] })
    lint(m, [counter])
    expect(exprVisits).toBeGreaterThan(0) // x, 2, x*2, 1, (x*2)+1 … all visited
  })

  it('the production registry holds the wired rules (append to scale)', () => {
    const ids = RULES.map((r) => r.id)
    expect(ids).toContain('single-exit')
    expect(ids).toContain('mixed-scalar')
    expect(ids).toContain('binding-collision')
  })

  it('formatDiagnostics renders a report (empty + non-empty, errors first)', () => {
    expect(formatDiagnostics([])).toBe('no lint diagnostics')
    const out = formatDiagnostics([
      { ruleId: 'w', severity: 'warning', message: 'mw', fn: 'f' },
      { ruleId: 'e', severity: 'error', message: 'me' },
    ])
    expect(out.split('\n')[0]).toContain('[error] e: me')
    expect(out).toContain('[warning] w (fn f): mw')
  })

  it('STRICT promotes a warning rule to error', () => {
    const m = wide7() // 7 params > default 6 → param-count
    expect(lint(m, RULES).find((d) => d.ruleId === 'param-count')?.severity).toBe('warning')
    expect(lint(m, RULES, STRICT).find((d) => d.ruleId === 'param-count')?.severity).toBe('error')
  })

  it('LENIENT turns off style/perf rules', () => {
    expect(lint(wide7(), RULES, LENIENT).map((d) => d.ruleId)).not.toContain('param-count')
  })

  it('summarize counts by severity and by rule', () => {
    const s = summarize([
      { ruleId: 'a', severity: 'error', message: '' },
      { ruleId: 'a', severity: 'warning', message: '' },
      { ruleId: 'b', severity: 'warning', message: '' },
    ])
    expect(s).toMatchObject({ total: 3, errors: 1, warnings: 2, byRule: { a: 2, b: 1 } })
  })

  it('unusedDeviations flags a lintDisable that never fires (and not one that does)', () => {
    const recRef = externFn('rec', { x: f32T }, f32T)
    const used = module({
      funcs: [
        fn('rec', { x: f32T }, f32T, ({ x }, _b) => recRef({ x }), {
          lintDisable: ['no-recursion'],
        }),
      ],
    })
    expect(unusedDeviations(used, RULES)).toEqual([]) // no-recursion DOES fire → deviation is used

    const stale = module({
      funcs: [
        fn('ok', { x: f32T }, f32T, ({ x }, _b) => x.mul(2), { lintDisable: ['no-recursion'] }),
      ],
    })
    expect(unusedDeviations(stale, RULES).map((d) => d.ruleId)).toEqual(['unused-lint-disable'])
  })
})
