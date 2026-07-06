import { describe, expect, it } from 'vitest'
import { compileModule } from './oracle'
import { module, fn, f32, f32T, mod, vec3, vec3fT, clamp, mix, type Node } from './ir'

// #13 (remaining half) — the oracle is the CPU half of a two-oracle contract; the
// GPU computes f32. Its `==` / `!=` must therefore reflect f32 rounding, not exact
// f64 equality, or it silently disagrees with the GPU on equality branches.
describe('oracle — f32-faithful equality (#13 fround compare)', () => {
  it('== returns true for two values equal after f32 rounding but unequal in f64', () => {
    // 1.0 and 1.0 + 2^-30 are distinct f64 numbers, but both round to 1.0f
    // (f32 ulp at 1.0 ≈ 1.19e-7 ≫ 2^-30 ≈ 9.3e-10). The GPU sees them equal.
    const m = module({
      funcs: [
        fn('eq1', { a: f32T, b: f32T }, f32T, ({ a, b }, bld) => {
          bld.ret(a.eq(b).select(f32(1), f32(0)))
        }),
      ],
    })
    const cpu = compileModule(m)
    expect(cpu.fns.eq1(1.0, 1.0 + 2 ** -30)).toBe(1)
  })

  it('!= returns false for the same f32-equal pair', () => {
    const m = module({
      funcs: [
        fn('ne1', { a: f32T, b: f32T }, f32T, ({ a, b }, bld) => {
          bld.ret(a.ne(b).select(f32(1), f32(0)))
        }),
      ],
    })
    const cpu = compileModule(m)
    expect(cpu.fns.ne1(1.0, 1.0 + 2 ** -30)).toBe(0)
  })

  it('== still distinguishes values that differ at f32 resolution', () => {
    const m = module({
      funcs: [
        fn('eq2', { a: f32T, b: f32T }, f32T, ({ a, b }, bld) => {
          bld.ret(a.eq(b).select(f32(1), f32(0)))
        }),
      ],
    })
    const cpu = compileModule(m)
    expect(cpu.fns.eq2(1.0, 1.5)).toBe(0)
  })
})

// vecN(singleScalar) is a WGSL SPLAT (all N components = the scalar). The CPU backend
// must match it — it previously returned a 1-element vector, silently disagreeing with
// the GPU (surfaced by the raster-color absorption oracle).
describe('oracle — vecN(scalar) splat matches WGSL', () => {
  it('vec3(0.5) splats to all three components', () => {
    const m = module({ funcs: [fn('s3', {}, vec3fT, () => vec3(f32(0.5)))] })
    expect(compileModule(m).fns.s3()).toEqual([0.5, 0.5, 0.5])
  })

  it('a multi-arg vec is unaffected', () => {
    const m = module({ funcs: [fn('s3b', {}, vec3fT, () => vec3(f32(1), f32(2), f32(3)))] })
    expect(compileModule(m).fns.s3b()).toEqual([1, 2, 3])
  })

  it('clamp(vecN, vecLo, vecHi) clamps component-wise (was scalar-only → null on vec bounds)', () => {
    const m = module({
      funcs: [fn('cl', { v: vec3fT }, vec3fT, ({ v }, _b) => clamp(v, vec3(f32(0)), vec3(f32(1))))],
    })
    expect(compileModule(m).fns.cl([-0.5, 1.5, 0.5])).toEqual([0, 1, 0.5])
  })

  // mix(vec a, scalar b) is type-legal (ArithArg broadcast) — the old mixVal only handled
  // (vec,vec) and (scalar,scalar), so a scalar endpoint against a vec fell to the scalar
  // path and did array+number arithmetic → NaN. Now broadcasts component-wise.
  it('mix(vec a, vec b, scalar t) interpolates component-wise', () => {
    const m = module({
      funcs: [fn('mx', { a: vec3fT, b: vec3fT }, vec3fT, ({ a, b }, _b) => mix(a, b, f32(0.25)))],
    })
    expect(compileModule(m).fns.mx([0, 0, 0], [4, 8, 100])).toEqual([1, 2, 25])
  })

  it('mix(vec a, scalar b, scalar t) broadcasts the scalar endpoint (was NaN on the scalar branch)', () => {
    // mix(vec, scalar, scalar) broadcasts the scalar endpoint to the vec — TS types mix's
    // return as the f32|vec3 union (it can't prove the broadcast), so assert the vec3 the
    // ret demands; the new fn() return-type enforcement requires this be explicit.
    const m = module({
      funcs: [
        fn(
          'mxb',
          { a: vec3fT },
          vec3fT,
          ({ a }, _b) => mix(a, f32(1), f32(0.5)) as Node<'vec3<f32>'>,
        ),
      ],
    })
    expect(compileModule(m).fns.mxb([0, 0.5, 1])).toEqual([0.5, 0.75, 1])
  })
})

// #839 — mod is FLOOR-mod on both targets; the oracle must match on the
// negative operands where floor-mod and JS/WGSL trunc-mod disagree.
describe('oracle — mod floor-mod semantics (#839)', () => {
  it('negative x wraps into [0, y) (trunc-mod would return a negative)', () => {
    const m = module({
      funcs: [fn('fm', { x: f32T, y: f32T }, f32T, ({ x, y }) => mod(x, y))],
    })
    const fm = compileModule(m).fns.fm
    expect(fm(-1.3, 2.6)).toBeCloseTo(1.3, 6) // JS -1.3 % 2.6 === -1.3
    expect(fm(5.2, 2.6)).toBeCloseTo(0, 6)
    expect(fm(-0.25, 1)).toBeCloseTo(0.75, 6)
  })

  it('broadcasts a scalar divisor over a vector component-wise', () => {
    const m = module({
      funcs: [fn('fmv', { p: vec3fT }, vec3fT, ({ p }) => mod(p, 2) as Node<'vec3<f32>'>)],
    })
    expect(compileModule(m).fns.fmv([-1, 3, 2])).toEqual([1, 1, 0])
  })
})
