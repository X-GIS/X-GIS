import { describe, it, expect } from 'vitest'
import { validate, ValidationError } from './validate'
import { compileModule } from '../oracle'
import {
  module, fn, f32, param, callFn, constRef, bindingRef, structT,
  f32T, u32T, vec4fT,
  type ModuleDecl, type Stmt,
} from '../ir'
import { getPROJECTION_MODULE } from '../../shaders/projections'

// The vitest global setup (runtime/src/test-setup-projections.ts) calls
// configureProjections(PROJECTIONS) before any suite runs, so the projection
// module is available here without an inline configure.

describe('validate', () => {
  // ── KNOWN-GOOD ──

  it('passes the projection module', () => {
    expect(() => validate(getPROJECTION_MODULE())).not.toThrow()
  })

  it('passes a hand-built good module (params + lets + return)', () => {
    const good = module({
      funcs: [
        fn('add_scaled', { a: f32T, b: f32T }, f32T, ({ a, b }, bld) => {
          const s = bld.let('s', a.add(b))
          const t = bld.let('t', s.mul(2))
          bld.ret(t)
        }),
      ],
    })
    expect(() => validate(good)).not.toThrow()
  })

  // ── FAIL-BEFORE (hand-built invalid modules) ──

  // RULE a' (varref/param scope resolution) was REMOVED — it false-flagged the
  // runtime polygon variant whose fs_fill references a compiler-injected name
  // (`OPACITY`, prepended as raw WGSL outside m.consts). validate must ACCEPT a
  // varref/param to a name it cannot see (regression guard, not a fail-before).
  it('does NOT flag a varref/param to a compiler-injected name (OPACITY regression)', () => {
    const m = module({
      funcs: [
        fn('fs_fill', {}, f32T, (_p, bld) => {
          bld.ret(param('OPACITY', f32T)) // injected outside m.consts; validate cannot know it
        }),
      ],
    })
    expect(() => validate(m)).not.toThrow()
  })

  it('throws on a binding collision', () => {
    const bad = module({
      bindings: [
        { group: 0, binding: 0, name: 'u_a', space: 'uniform', type: f32T },
        { group: 0, binding: 0, name: 'u_b', space: 'uniform', type: f32T },
      ],
    })
    expect(() => validate(bad)).toThrow(ValidationError)
  })

  it('throws on a duplicate struct name', () => {
    const bad: ModuleDecl = module({
      structs: [
        { name: 'U', fields: [] },
        { name: 'U', fields: [] },
      ],
    })
    expect(() => validate(bad)).toThrow(ValidationError)
  })

  it('throws on a duplicate func name', () => {
    const bad = module({
      funcs: [
        fn('foo', {}, f32T, (_p, bld) => { bld.ret(f32(1)) }),
        fn('foo', {}, f32T, (_p, bld) => { bld.ret(f32(2)) }),
      ],
    })
    expect(() => validate(bad)).toThrow(ValidationError)
  })

  it('throws on a non-void fn that never returns', () => {
    const bad = module({
      funcs: [
        fn('no_return', {}, f32T, (_p, bld) => {
          bld.let('unused', f32(1)) // a let, no return → falls through
        }),
      ],
    })
    expect(() => validate(bad)).toThrow(ValidationError)
  })

  // ── BACKEND WIRING: the oracle (compileModule) validates the same IR ──

  it('compileModule (oracle) validates the module — throws on a structurally-invalid one', () => {
    // The oracle is the third backend over the same IR; it must reject what the
    // WGSL/GLSL writers reject (here: a duplicate function name).
    const bad = module({
      funcs: [
        fn('dup', {}, f32T, (_p, b) => { b.ret(f32(1)) }),
        fn('dup', {}, f32T, (_p, b) => { b.ret(f32(2)) }),
      ],
    })
    expect(() => compileModule(bad)).toThrow(ValidationError)
  })

  // ── RULE t: mixed-scalar int/float binop (#5b) ──

  it('throws on a mixed-scalar int/float binop (f32 + u32) — WGSL forbids implicit mixing', () => {
    // WGSL has no implicit int↔float conversion; `a + b` with a:f32, b:u32 is a
    // compile error there, so validate must reject it at authoring time rather
    // than emit code the driver rejects. (The typed-lift only fixes the bare-NUMBER
    // case; a Node-vs-Node scalar mismatch needs the validator.)
    const bad = module({
      funcs: [
        fn('mixed', { a: f32T, b: u32T }, f32T, ({ a, b }, bld) => {
          bld.ret(a.add(b))
        }),
      ],
    })
    expect(() => validate(bad)).toThrow(ValidationError)
  })

  // ── SAFETY REGRESSION (must NOT throw) ──

  it('does not throw on a fn with a raw Stmt and no explicit return', () => {
    const m: ModuleDecl = module({
      funcs: [{
        name: 'raw_fn',
        params: [],
        ret: f32T,
        body: [{ s: 'raw', wgsl: 'return 1.0;' } as Stmt],
      }],
    })
    expect(() => validate(m)).not.toThrow()
  })

  it('does not throw on a fn with a placeholder Stmt', () => {
    const m: ModuleDecl = module({
      funcs: [{
        name: 'ph_fn',
        params: [],
        ret: vec4fT,
        body: [{ s: 'placeholder', tag: 'fill-return' } as Stmt],
      }],
    })
    expect(() => validate(m)).not.toThrow()
  })

  it('does not throw on a constref not in module.consts', () => {
    const m = module({
      funcs: [
        fn('uses_const', {}, f32T, (_p, bld) => {
          // PI is prepended as raw WGSL, never in m.consts — must be skipped.
          bld.ret(constRef('PI').mul(2))
        }),
      ],
    })
    expect(() => validate(m)).not.toThrow()
  })

  it('does not throw on a fn referencing a module binding by name (regression: false-flagged `u`)', () => {
    // polygon_cos_c_fragment references `u` = @group(0)@binding(0) var<uniform> u.
    // Module bindings are in scope everywhere; validate must not flag them.
    const m = module({
      structs: [{ name: 'Uniforms', fields: [{ name: 'k', type: f32T }] }],
      bindings: [{ group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('Uniforms') }],
      funcs: [
        fn('uses_binding', {}, f32T, (_p, bld) => {
          bld.ret(bindingRef('u', structT('Uniforms')).field('k', f32T))
        }),
      ],
    })
    expect(() => validate(m)).not.toThrow()
  })

  it('does not throw when a raw Stmt declares a name a sibling varref uses (regression: `_mcSS`)', () => {
    // The polygon composer injects `var _mcSS: vec4f = …;` as a raw preamble,
    // then a structured varref references _mcSS. validate cannot parse raw WGSL,
    // so RULE a' is skipped for any fn containing a raw Stmt.
    const m: ModuleDecl = module({
      funcs: [{
        name: 'fs_fill',
        params: [],
        ret: vec4fT,
        body: [
          { s: 'raw', wgsl: 'var _mcSS: vec4f = vec4f(0.0);' } as Stmt,
          { s: 'return', expr: { op: 'varref', type: vec4fT, name: '_mcSS' } } as Stmt,
        ],
      }],
    })
    expect(() => validate(m)).not.toThrow()
  })

  it('does not throw on a cross-module callFn target not in module.funcs', () => {
    const m = module({
      funcs: [
        fn('caller', { lon: f32T, lat: f32T }, vec4fT, ({ lon, lat }, bld) => {
          // proj_globe is prepended as raw WGSL, never in m.funcs.
          bld.ret(callFn('proj_globe', vec4fT, lon, lat))
        }),
      ],
    })
    expect(() => validate(m)).not.toThrow()
  })
})
