import { describe, it, expect } from 'vitest'
import { validate, ValidationError } from './validate'
import { module, fn, f32T, f32 } from '../ir'
import { structDecl } from '../sot'

describe('validate — aggregated errors', () => {
  it('throws ONE ValidationError listing ALL CORE errors, not just the first', () => {
    const S = structDecl('S', { a: f32T })
    const m = module({
      structs: [S.decl, S.decl], // dup-struct
      funcs: [
        fn('g', {}, f32T, () => f32(0)),
        fn('g', {}, f32T, () => f32(0)), // dup-func
      ],
    })

    let err: unknown
    try { validate(m) } catch (e) { err = e }

    expect(err).toBeInstanceOf(ValidationError)
    const ve = err as ValidationError
    expect(ve.diagnostics.length).toBeGreaterThanOrEqual(2)
    const rules = ve.diagnostics.map((d) => d.ruleId)
    expect(rules).toContain('dup-struct')
    expect(rules).toContain('dup-func')
    // The message body enumerates every error (count in the header).
    expect(ve.message).toContain('module validation failed')
    expect(ve.message).toContain('dup-struct')
    expect(ve.message).toContain('dup-func')
  })

  it('does not throw on a clean module', () => {
    const m = module({ funcs: [fn('ok', { x: f32T }, f32T, ({ x }) => x.add(f32(1)))] })
    expect(() => validate(m)).not.toThrow()
  })
})
