import { describe, expect, it } from 'vitest'
import {
  module, fn, f32T, vec3fT,
  normalize, distance, cross, step, exp2, trunc, round, inverseSqrt,
} from './'
import { emitModule } from '../backends/wgsl'
import { compileModule } from '../oracle'
import { spellIntrinsic } from '../intrinsics'

// Newly-added standard GLSL/WGSL builtins (normalize / distance / cross / step /
// exp2 / trunc / round / inverseSqrt). Each must (1) emit its WGSL spelling,
// (2) evaluate on the CPU oracle (the two-oracle contract), and — for the one
// divergent spelling — (3) map to the GLSL name. WGSL and GLSL spell all of these
// identically EXCEPT inverseSqrt (GLSL `inversesqrt`), which the intrinsic registry
// already rewrites; the others fall through `spellIntrinsic` as identity.

describe('stdlib builtins — WGSL emit', () => {
  it('emits each builtin spelling', () => {
    const wgsl = emitModule(module({
      funcs: [
        fn('a', { v: vec3fT }, vec3fT, ({ v }, b) => b.ret(normalize(v))),
        fn('b', { a: vec3fT, c: vec3fT }, f32T, ({ a, c }, b) => b.ret(distance(a, c))),
        fn('c', { a: vec3fT, c: vec3fT }, vec3fT, ({ a, c }, b) => b.ret(cross(a, c))),
        fn('e', { x: f32T }, f32T, ({ x }, b) => b.ret(step(0.5, x))),
        fn('g', { x: f32T }, f32T, ({ x }, b) => b.ret(exp2(x))),
        fn('h', { x: f32T }, f32T, ({ x }, b) => b.ret(trunc(x))),
        fn('j', { x: f32T }, f32T, ({ x }, b) => b.ret(round(x))),
        fn('k', { x: f32T }, f32T, ({ x }, b) => b.ret(inverseSqrt(x))),
      ],
    }))
    for (const s of ['normalize(', 'distance(', 'cross(', 'step(', 'exp2(', 'trunc(', 'round(', 'inverseSqrt(']) {
      expect(wgsl).toContain(s)
    }
  })
})

describe('stdlib builtins — CPU oracle eval', () => {
  it('normalize → unit vector', () => {
    const f = compileModule(module({ funcs: [fn('f', { v: vec3fT }, vec3fT, ({ v }, b) => b.ret(normalize(v)))] })).fns.f
    expect(f([3, 0, 4])).toEqual([0.6, 0, 0.8])
  })
  it('distance → |a − b|', () => {
    const f = compileModule(module({ funcs: [fn('f', { a: vec3fT, b: vec3fT }, f32T, ({ a, b }, bl) => bl.ret(distance(a, b)))] })).fns.f
    expect(f([0, 0, 0], [3, 4, 0])).toBe(5)
  })
  it('cross → right-hand normal', () => {
    const f = compileModule(module({ funcs: [fn('f', { a: vec3fT, b: vec3fT }, vec3fT, ({ a, b }, bl) => bl.ret(cross(a, b)))] })).fns.f
    expect(f([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1])
  })
  it('step → 0 below edge, 1 at/above', () => {
    const f = compileModule(module({ funcs: [fn('f', { x: f32T }, f32T, ({ x }, b) => b.ret(step(0.5, x)))] })).fns.f
    expect([f(0.3), f(0.5), f(0.7)]).toEqual([0, 1, 1])
  })
  it('exp2 → 2ˣ', () => {
    const f = compileModule(module({ funcs: [fn('f', { x: f32T }, f32T, ({ x }, b) => b.ret(exp2(x)))] })).fns.f
    expect(f(3)).toBe(8)
  })
  it('trunc → toward zero', () => {
    const f = compileModule(module({ funcs: [fn('f', { x: f32T }, f32T, ({ x }, b) => b.ret(trunc(x)))] })).fns.f
    expect([f(2.7), f(-2.7)]).toEqual([2, -2])
  })
  it('round → ties to even (NOT Math.round)', () => {
    const f = compileModule(module({ funcs: [fn('f', { x: f32T }, f32T, ({ x }, b) => b.ret(round(x)))] })).fns.f
    expect([f(2.4), f(2.5), f(3.5), f(-2.5)]).toEqual([2, 2, 4, -2])
  })
  it('inverseSqrt → 1/√x', () => {
    const f = compileModule(module({ funcs: [fn('f', { x: f32T }, f32T, ({ x }, b) => b.ret(inverseSqrt(x)))] })).fns.f
    expect(f(4)).toBe(0.5)
  })
})

describe('stdlib builtins — GLSL spelling divergence', () => {
  it('inverseSqrt → GLSL inversesqrt; WGSL inverseSqrt', () => {
    expect(spellIntrinsic('glsl', 'inverseSqrt', ['x'])).toBe('inversesqrt(x)')
    expect(spellIntrinsic('wgsl', 'inverseSqrt', ['x'])).toBe('inverseSqrt(x)')
  })
  it('the identical-spelling builtins fall through as identity on GLSL', () => {
    for (const fnName of ['normalize', 'distance', 'cross', 'step', 'exp2', 'trunc', 'round']) {
      expect(spellIntrinsic('glsl', fnName, ['a'])).toBe(`${fnName}(a)`)
    }
  })
})
