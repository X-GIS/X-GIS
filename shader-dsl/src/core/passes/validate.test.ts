import { describe, it, expect } from 'vitest'
import { validate, ValidationError } from './validate'
import { module, fn, f32T, i32T, f32 } from '../ir'
import { structDecl, uniformStruct } from '../sot'
import { CORE_RULES } from './lint/rules'

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

// ═══ #763 V1 — firing fixtures for the CORE rules that had none ═══
//
// engine.test.ts pins rule MEMBERSHIP (ids present in the registry); these pin that each
// rule's visitor actually FIRES through the real validate() path. Without a positive
// fixture, a rule whose create() silently stops reporting stays green forever.

function coreErrorsOf(m: Parameters<typeof validate>[0]): string[] {
  try { validate(m) } catch (e) {
    if (e instanceof ValidationError) return e.diagnostics.map((d) => d.ruleId)
    throw e
  }
  return []
}

describe('#763 V1 — CORE rule firing fixtures', () => {
  it('all-paths-return fires: a non-void fn that can fall off the end', () => {
    const bad = fn('v1_ap', { x: f32T }, f32T, ({ x }, b) => {
      b.if(x.gt(0), (bb) => bb.ret(x)) // no else, no trailing return
    })
    expect(coreErrorsOf(module({ funcs: [bad] }))).toContain('all-paths-return')
  })

  it('binding-collision fires: two bindings sharing @group/@binding', () => {
    const U1 = uniformStruct('V1ColA', { group: 0, binding: 0, as: 'v1ca' }, { t: f32T })
    const U2 = uniformStruct('V1ColB', { group: 0, binding: 0, as: 'v1cb' }, { t: f32T })
    const m = module({ uses: [U1, U2], funcs: [fn('v1_ok', {}, f32T, () => f32(1))] })
    expect(coreErrorsOf(m)).toContain('binding-collision')
  })

  it('mixed-scalar fires: an i32 × f32 binop (tsc blocks it; runtime composition cannot)', () => {
    // The cast models the real hazard: a node WIDENED to ReadonlyNode<string> (generic
    // helpers, R1 records) sails through tsc — the lint rule is the only net.
    const bad = fn('v1_ms', { i: i32T, x: f32T }, ({ i, x }) => i.mul(x as unknown as never))
    expect(coreErrorsOf(module({ funcs: [bad] }))).toContain('mixed-scalar')
  })

  // ── V2 — the CORE catalogue itself, pinned (intrinsic-coverage style) ──
  // Silently dropping a rule from CORE_RULES (e.g. a refactor that forgets call-signature)
  // is invisible to every other test; this makes it a one-line, reviewed diff.
  it('#763 V2 — CORE_RULES id catalogue is exactly the six structural invariants', () => {
    expect(CORE_RULES.map((r) => r.id)).toEqual([
      'dup-struct', 'dup-func', 'binding-collision', 'all-paths-return', 'mixed-scalar', 'call-signature',
    ])
  })
})
