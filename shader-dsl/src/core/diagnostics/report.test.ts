import { describe, it, expect } from 'vitest'
import { diagnose, formatReport } from './report'
import { module, fn, f32T, f32 } from '../ir'
import type { Backend } from '../backend'

// A minimal backend stub that covers everything EXCEPT compute — diagnose() reads only
// `id` and `caps.covers/missing`, so we don't need a full Backend implementation.
const noComputeBackend = {
  id: 'stub',
  caps: {
    covers: (req: readonly string[]) => !req.includes('compute'),
    missing: (req: readonly string[]) => req.filter((c) => c === 'compute'),
  },
} as unknown as Backend

describe('diagnose / formatReport', () => {
  it('returns a structured report with a summary', () => {
    const m = module({ funcs: [fn('ok', { x: f32T }, f32T, ({ x }) => x.add(f32(1)))] })
    const r = diagnose(m)
    expect(r).toHaveProperty('diagnostics')
    expect(r).toHaveProperty('summary')
    expect(r.summary.total).toBe(r.diagnostics.length)
  })

  it('reports a missing backend capability alongside lint (non-throwing)', () => {
    const m = module({ funcs: [fn('cs', {}, () => {}, { stage: 'compute' })] })
    const r = diagnose(m, { rules: 'core', backend: noComputeBackend })
    const cap = r.diagnostics.find((d) => d.ruleId === 'unsupported-capability')
    expect(cap).toBeDefined()
    expect(cap!.severity).toBe('error')
    expect(cap!.code).toBe('SD0030')
    expect(cap!.message).toContain('compute')
    expect(r.summary.errors).toBeGreaterThanOrEqual(1)
  })

  it('formatReport renders a code + severity + footer; empty report is "no diagnostics"', () => {
    const clean = diagnose(module({ funcs: [fn('ok', { x: f32T }, f32T, ({ x }) => x.add(f32(1)))] }), { rules: 'core' })
    expect(formatReport(clean)).toBe('no diagnostics')

    const m = module({ funcs: [fn('cs', {}, () => {}, { stage: 'compute' })] })
    const text = formatReport(diagnose(m, { rules: 'core', backend: noComputeBackend }))
    expect(text).toContain('error[SD0030]')
    expect(text).toContain('unsupported-capability')
    expect(text).toMatch(/\d+ error/)
  })
})
