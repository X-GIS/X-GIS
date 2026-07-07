// ═══ fp64Lower pass tests — rewrite shape, fail-loud gates, identity ═══

import { describe, it, expect } from 'vitest'
import { fn, module, f64T, f32T, vec4fT, toF32, toF64, sqrt, sin } from '../ir'
import { fp64Guard, FP64_GUARD_NAME } from '../fp64/df64-lib'
import { ioStruct, location, builtin, uniformStruct, resource } from '../sot'
import { fp64Lower } from './fp64-lower'
import { emitModule } from '../backends/wgsl'

describe('identity for non-f64 modules', () => {
  it('returns the SAME module object when no f64 appears anywhere', () => {
    const plain = fn('plain', { x: f32T }, (p) => p.x.mul(2.0).add(1.0))
    const m = module({ funcs: [plain] })
    expect(fp64Lower(m)).toBe(m)
  })
})

describe('rewrite shapes', () => {
  it('binops become df64_* calls; helpers + their transitive deps are injected', () => {
    const k = fn('k', { a: f64T, b: f64T }, (p) => p.a.add(p.b).mul(p.a))
    const lowered = fp64Lower(module({ funcs: [k] }))
    const names = lowered.funcs.map((f) => f.name)
    expect(names[0]).toBe('k')
    // Direct helpers…
    expect(names).toContain('df64_add')
    expect(names).toContain('df64_mul')
    // …and their transitive EFT primitives, in fixed dependency-first order.
    expect(names.indexOf('df64_twoSum')).toBeLessThan(names.indexOf('df64_add'))
    expect(names.indexOf('df64_split')).toBeLessThan(names.indexOf('df64_twoProd'))
    expect(names.indexOf('df64_twoProd')).toBeLessThan(names.indexOf('df64_mul'))
    // Unused helpers stay out (right-sized injection).
    expect(names).not.toContain('df64_sqrt')
    expect(names).not.toContain('df64_div')
  })

  it('an f64 literal lowers to a vec2<f32>(hi, lo) split at BUILD time', () => {
    const k = fn('k', { a: f64T }, (p) => p.a.add(1e8 + 0.5))
    const wgsl = emitModule(module({ funcs: [k] }))
    // splitF64(1e8 + 0.5) = [1e8, 0.5] — both halves exactly representable.
    expect(wgsl).toContain('vec2<f32>(100000000.0, 0.5)')
  })

  it('a mixed f64∘f32 operand widens as vec2<f32>(x, 0.0) — the pass is the widen authority', () => {
    const k = fn('k', { a: f64T, s: f32T }, (p) => p.a.mul(p.s))
    const wgsl = emitModule(module({ funcs: [k] }))
    expect(wgsl).toContain('df64_mul(a, vec2<f32>(s, 0.0))')
  })

  it('comparisons lower to the lexicographic df64 comparators', () => {
    const k = fn('k', { a: f64T, b: f64T }, (p) => p.a.lt(p.b).select(1.0, 0.0))
    const wgsl = emitModule(module({ funcs: [k] }))
    expect(wgsl).toContain('df64_lt(a, b)')
  })

  it('sqrt on f64 lowers to df64_sqrt; toF64/toF32 lower to widen/narrow', () => {
    const k = fn('k', { a: f64T, s: f32T }, (p) => toF32(sqrt(p.a.add(toF64(p.s)))))
    const wgsl = emitModule(module({ funcs: [k] }))
    expect(wgsl).toContain('df64_narrow(df64_sqrt(df64_add(a, vec2<f32>(s, 0.0))))')
  })

  it('f64 params/returns become vec2<f32>; no f64 token survives lowering', () => {
    const k = fn('k', { a: f64T }, (p) => p.a.add(p.a))
    const wgsl = emitModule(module({ funcs: [k] }))
    expect(wgsl).toContain('fn k(a: vec2<f32>) -> vec2<f32>')
    expect(wgsl).not.toMatch(/\bf64\b/)
  })

  it('an f64 uniform field lowers to a vec2<f32> field', () => {
    const U = uniformStruct(
      'KParams',
      { group: 0, binding: 1, as: 'params' },
      {
        origin: f64T,
        scale: f32T,
      },
    )
    const k = fn('k', { x: f32T }, (p) => toF32(U.field.origin.add(toF64(p.x))))
    const wgsl = emitModule(module({ funcs: [k], uses: [U] }))
    expect(wgsl).toContain('origin: vec2<f32>,')
    expect(wgsl).toContain('params.origin')
  })
})

describe('guard auto-injection', () => {
  it('injects the _fp64 guard TEXTURE at (0, 0) when the module declares no bindings', () => {
    const k = fn('k', { a: f64T, b: f64T }, (p) => p.a.add(p.b))
    const lowered = fp64Lower(module({ funcs: [k] }))
    expect(lowered.bindings).toEqual([
      {
        group: 0,
        binding: 0,
        name: FP64_GUARD_NAME,
        space: 'uniform',
        type: { kind: 'texture', dim: '2d', elem: 'f32' },
      },
    ])
    // The guard value is a texel fetch — opaque to every downstream compiler
    // (a UBO-sourced guard is defeated by uniform-value pipeline
    // specialization; observed on Windows/NVIDIA).
    const wgsl = emitModule(module({ funcs: [k] }))
    expect(wgsl).toContain(`var ${FP64_GUARD_NAME}: texture_2d<f32>;`)
    expect(wgsl).toContain(`textureLoad(${FP64_GUARD_NAME}, vec2<i32>(0, 0), 0).x`)
  })

  it('injects past the module’s own group-0 bindings (deterministic, collision-free)', () => {
    const U = uniformStruct('P', { group: 0, binding: 3, as: 'p' }, { origin: f64T })
    const k = fn('k', { x: f32T }, (p) => toF32(U.field.origin.add(toF64(p.x))))
    const lowered = fp64Lower(module({ funcs: [k], uses: [U] }))
    const g = lowered.bindings.find((b) => b.name === FP64_GUARD_NAME)!
    expect([g.group, g.binding]).toEqual([0, 4])
  })

  it('honours an explicit fp64Guard pin (engine bind-group layouts)', () => {
    const k = fn('k', { a: f64T, b: f64T }, (p) => p.a.add(p.b))
    const lowered = fp64Lower(module({ funcs: [k], uses: [fp64Guard({ group: 2, binding: 5 })] }))
    const g = lowered.bindings.find((b) => b.name === FP64_GUARD_NAME)!
    expect([g.group, g.binding]).toEqual([2, 5])
    // No duplicate injection alongside the pin.
    expect(lowered.bindings.filter((b) => b.name === FP64_GUARD_NAME)).toHaveLength(1)
  })

  it('no guard is injected when f64 is carried but never computed (no helpers used)', () => {
    // Pure pass-through: an f64 param forwarded to a user fn — type mapping
    // only, no emulation, so no guard requirement lands on the host.
    const inner = fn('inner', { v: f64T }, (p) => p.v)
    const outer = fn('outer', { v: f64T }, (p) => inner({ v: p.v }))
    const lowered = fp64Lower(module({ funcs: [outer] }))
    expect(lowered.bindings).toEqual([])
  })
})

describe('fail-loud gates', () => {
  it('SD0042 — a conflicting _fp64 binding (reserved name, wrong shape)', () => {
    const squatter = resource('_fp64', f32T, { group: 0, binding: 0 })
    const k = fn('k', { a: f64T, b: f64T }, (p) => p.a.add(p.b))
    expect(() => fp64Lower(module({ funcs: [k], uses: [squatter] }))).toThrow(/SD0042/)
  })

  it('SD0041 — a non-whitelisted builtin on f64 operands', () => {
    const k = fn('k', { a: f64T }, (p) => sin(p.a))
    expect(() => fp64Lower(module({ funcs: [k] }))).toThrow(/SD0041/)
  })

  it("SD0043 — authored fn names must not squat the reserved 'df64_' prefix", () => {
    const bad = fn('df64_mine', { a: f64T }, (p) => p.a.add(p.a))
    expect(() => fp64Lower(module({ funcs: [bad] }))).toThrow(/SD0043/)
  })

  it('SD0044 — an interpolated @location IO field of f64 is rejected', () => {
    const Out = ioStruct('VOut', {
      pos: builtin('position', vec4fT),
      depth: location(0, f64T),
    })
    const vs = fn(
      'vs',
      { a: f64T },
      (p) => {
        const o = Out.var()
        o.depth.assign(p.a)
        return o
      },
      { stage: 'vertex' },
    )
    expect(() => fp64Lower(module({ funcs: [vs], structs: [Out.decl] }))).toThrow(/SD0044/)
  })
})

describe('optimizer invariants (the guard survives O2)', () => {
  it('df64_* calls stay opaque and every injected helper still threads the guard after the fixpoint', () => {
    const k = fn('k', { a: f64T, b: f64T }, (p) => sqrt(p.a.add(p.b).mul(p.a).div(p.b)))
    const wgsl = emitModule(module({ funcs: [k] }))
    // The entry still CALLS the helpers (nothing inlined the EFT bodies).
    expect(wgsl).toMatch(/df64_sqrt\(/)
    expect(wgsl).toMatch(/df64_div\(/)
    // Every EFT-bearing helper body still multiplies through the opaque one —
    // the algebraic pass must never treat the guard fetch as `* 1.0`. (The
    // fetch may be CSE-hoisted, so assert the texture ref survives per body.)
    for (const name of ['df64_twoSum', 'df64_quickTwoSum', 'df64_split']) {
      const body = wgsl.split(`fn ${name}(`)[1]!.split('\nfn ')[0]!
      expect(body).toContain('_fp64')
    }
  })
})
