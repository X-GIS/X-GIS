// ═══ vecN<f64> tests — authoring surface, lowering shapes, known answers ═══
//
// The vector milestone of the fp64 feature: same operator syntax, vec64 kinds.
// Known answers run under the SAME f32-rounding oracle as the scalar suite
// (every f32 op frounded), so the vectorized EFT bodies are exercised as a
// correctly-rounding f32 machine would run them.

import { describe, it, expect } from 'vitest'
import {
  fn,
  module,
  f64,
  f64T,
  f32,
  f32T,
  vec3fT,
  vec2f64,
  vec3f64,
  vec3f64T,
  vec2f64T,
  typeKey,
  dot,
  length,
  distance,
  normalize,
  abs,
  min,
  max,
  mix,
  fract,
  floor,
  exp,
  toF32,
  type Expr,
  type ModuleDecl,
  type ShaderType,
} from '../ir'
import { uniformStruct } from '../sot'
import { compileModule, type CpuValue } from '../oracle'
import { fp64Lower } from '../passes/fp64-lower'
import { mapModuleExprs } from '../passes/opt/ir-transform'
import { emitModule } from '../backends/wgsl'
import { wgslLayout } from '../reflect'
import { splitF64, FP64_GUARD_NAME } from './df64-lib'

// ── Authoring surface ──

describe('vec64 authoring surface', () => {
  it('constructors, keys, components, swizzles', () => {
    const v = vec3f64(1e8 + 0.5, 2, 3)
    expect(typeKey(v.type)).toBe('vec3<f64>')
    expect(typeKey(v.x.type)).toBe('f64')
    expect(typeKey(v.xy.type)).toBe('vec2<f64>')
    expect(typeKey(v.zyx.type)).toBe('vec3<f64>')
  })

  it('componentwise ops and broadcasts type as vec64; dot/length are f64', () => {
    const a = vec3f64(1, 2, 3)
    const b = vec3f64(4, 5, 6)
    expect(typeKey(a.add(b).type)).toBe('vec3<f64>')
    expect(typeKey(a.mul(f64(2)).type)).toBe('vec3<f64>')
    expect(typeKey(a.mul(f32(2)).type)).toBe('vec3<f64>')
    expect(typeKey(a.mul(2).type)).toBe('vec3<f64>')
    expect(typeKey(a.neg().type)).toBe('vec3<f64>')
    expect(typeKey(dot(a, b).type)).toBe('f64')
    expect(typeKey(length(a).type)).toBe('f64')
    expect(typeKey(distance(a, b).type)).toBe('f64')
  })

  it('mixed widths / ints reject at author time', () => {
    expect(() => vec3f64(1, 2, 3).add(vec2f64(1, 2) as never)).toThrow(/SD0002/)
    expect(() => vec3f64(1, 2, 3).mod(vec3f64(1, 2, 3))).toThrow(/SD0041/)
  })
})

// ── Lowering shapes ──

describe('vec64 lowering', () => {
  it('binops lower to df64_vN_*; the DF64VecN struct + guard are injected', () => {
    const k = fn('k', { a: vec3f64T, b: vec3f64T }, (p) => p.a.add(p.b).mul(p.a))
    const lowered = fp64Lower(module({ funcs: [k] }))
    const names = lowered.funcs.map((f) => f.name)
    expect(names).toContain('df64_v3_add')
    expect(names).toContain('df64_v3_mul')
    expect(names).toContain('df64_v3_twoSum')
    expect(lowered.structs.some((s) => s.name === 'DF64Vec3')).toBe(true)
    expect(lowered.bindings.some((b) => b.name === FP64_GUARD_NAME)).toBe(true)
    const wgsl = emitModule(module({ funcs: [k] }))
    expect(wgsl).toContain('fn k(a: DF64Vec3, b: DF64Vec3) -> DF64Vec3')
    expect(wgsl).toContain('df64_v3_mul(df64_v3_add(a, b), a)')
  })

  it('components/swizzles reassemble from the hi/lo planes', () => {
    const k = fn('k', { a: vec3f64T }, (p) => toF32(p.a.x))
    const wgsl = emitModule(module({ funcs: [k] }))
    expect(wgsl).toContain('df64_narrow(vec2<f32>(a.hi.x, a.lo.x))')
  })

  it('dot composes scalar df64 mul/add chains across lanes', () => {
    const k = fn('k', { a: vec2f64T, b: vec2f64T }, (p) => toF32(dot(p.a, p.b)))
    const wgsl = emitModule(module({ funcs: [k] }))
    expect(wgsl).toContain(
      'df64_add(df64_mul(vec2<f32>(a.hi.x, a.lo.x), vec2<f32>(b.hi.x, b.lo.x)), df64_mul(vec2<f32>(a.hi.y, a.lo.y), vec2<f32>(b.hi.y, b.lo.y)))',
    )
  })

  it('a vec64 uniform field maps to the DF64VecN struct field', () => {
    const U = uniformStruct('P', { group: 0, binding: 0, as: 'p' }, { origin: vec3f64T })
    const k = fn('k', { s: f64T }, (p) => U.field.origin.mul(p.s))
    const wgsl = emitModule(module({ funcs: [k], uses: [U] }))
    expect(wgsl).toContain('origin: DF64Vec3,')
  })

  it('componentwise builtins lower to df64_vN_* and pull the scalar helpers', () => {
    const k = fn('k', { a: vec3f64T, b: vec3f64T }, (p) =>
      normalize(abs(p.a).add(min(p.a, max(p.a, p.b)))),
    )
    const lowered = fp64Lower(module({ funcs: [k] }))
    const names = lowered.funcs.map((f) => f.name)
    expect(names).toContain('df64_v3_abs')
    expect(names).toContain('df64_v3_min')
    expect(names).toContain('df64_v3_max')
    expect(names).toContain('df64_v3_normalize')
    // per-lane composition inside the helper bodies → closure pulls the
    // scalar fns (and normalize's length chain needs sqrt).
    expect(names).toContain('df64_abs')
    expect(names).toContain('df64_min')
    expect(names).toContain('df64_sqrt')
    const wgsl = emitModule(module({ funcs: [k] }))
    expect(wgsl).toContain('df64_v3_normalize(')
  })

  it('vec64 mix broadcasts a/b operands and takes a SCALAR f32 interpolant only', () => {
    const ok = fn('k', { a: vec3f64T, t: f32T }, (p) => mix(p.a, f64(1), p.t))
    const names = fp64Lower(module({ funcs: [ok] })).funcs.map((f) => f.name)
    expect(names).toContain('df64_v3_mix')
    const bad = fn('k', { a: vec3f64T, b: vec3f64T, t: vec3fT }, (p) => mix(p.a, p.b, p.t as never))
    expect(() => fp64Lower(module({ funcs: [bad] }))).toThrow(/SD0041/)
  })

  it('unsupported builtins / attributes / assigns fail loud', () => {
    // exp is NOT emulated on vec64 (sin/cos ARE — see the known-answer block).
    const s = fn('s', { a: vec3f64T }, (p) => exp(p.a))
    expect(() => fp64Lower(module({ funcs: [s] }))).toThrow(/SD0041/)
    const attr = fn('vs', { pos: { type: vec3f64T, attr: '@location(0)', location: 0 } }, (p) =>
      toF32(length(p.pos)),
    )
    expect(() =>
      fp64Lower(module({ funcs: [{ ...attr.decl, stage: 'vertex' as const }] })),
    ).toThrow(/SD0041/)
  })

  it('typeLayout: vec64 matches its lowered struct layout under both layouts', () => {
    const L140 = wgslLayout({ name: 'S', fields: [{ name: 'o', type: vec3f64T }] }, 'std140')
    expect(L140.fields[0]).toMatchObject({ size: 32, align: 16 })
    const L430 = wgslLayout({ name: 'S', fields: [{ name: 'o', type: vec2f64T }] }, 'std430')
    expect(L430.fields[0]).toMatchObject({ size: 16, align: 8 })
  })
})

// ── Known answers under the f32-rounding oracle ──

const isF32ish = (t: ShaderType): boolean =>
  (t.kind === 'scalar' && t.scalar === 'f32') || (t.kind === 'vec' && t.elem === 'f32')
const froundWrap = (e: Expr): Expr => {
  if ((e.op === 'binop' || e.op === 'unop' || e.op === 'call') && isF32ish(e.type)) {
    if (e.op === 'call' && e.fn === '__fround') return e
    return { op: 'call', type: e.type, fn: '__fround', args: [e] }
  }
  return e
}
function f32Oracle(m: ModuleDecl): ReturnType<typeof compileModule> {
  const cpu = compileModule(mapModuleExprs(fp64Lower(m), froundWrap))
  cpu.fns['__fround'] = (x: CpuValue) =>
    Array.isArray(x) ? (x as number[]).map(Math.fround) : Math.fround(x as number)
  return cpu
}

const m = module({
  funcs: [
    fn('v_add', { a: vec3f64T, b: vec3f64T }, (p) => p.a.add(p.b)),
    fn('v_mul', { a: vec3f64T, b: vec3f64T }, (p) => p.a.mul(p.b)),
    fn('v_dot', { a: vec3f64T, b: vec3f64T }, (p) => dot(p.a, p.b)),
    fn('v_len', { a: vec3f64T }, (p) => length(p.a)),
    fn('v_abs', { a: vec3f64T }, (p) => abs(p.a)),
    fn('v_min', { a: vec3f64T, b: vec3f64T }, (p) => min(p.a, p.b)),
    fn('v_mix', { a: vec3f64T, b: vec3f64T, t: f32T }, (p) => mix(p.a, p.b, p.t)),
    fn('v_fract', { a: vec3f64T }, (p) => fract(p.a)),
    fn('v_floor', { a: vec3f64T }, (p) => floor(p.a)),
    fn('v_norm', { a: vec3f64T }, (p) => normalize(p.a)),
  ],
})
const cpu = f32Oracle(m)

/** Host packing of a vec3<f64>: the DF64Vec3 CpuStruct { hi, lo } planes. */
const packV3 = (v: [number, number, number]): CpuValue => {
  const parts = v.map(splitF64)
  return { hi: parts.map((p) => p[0]), lo: parts.map((p) => p[1]) }
}
const sum = (r: CpuValue): number => {
  const [hi, lo] = r as number[]
  return hi! + lo!
}

describe('vec64 known answers (f32-rounding oracle)', () => {
  it('componentwise add recovers per-lane cancellations f32 loses', () => {
    const a: [number, number, number] = [2 ** 20 + 2 ** -20, 1e8 + 0.5, 1]
    const b: [number, number, number] = [-(2 ** 20), -1e8, 1]
    const r = cpu.fns.v_add!(packV3(a), packV3(b)) as { hi: number[]; lo: number[] }
    expect(r.hi[0]! + r.lo[0]!).toBe(2 ** -20)
    expect(r.hi[1]! + r.lo[1]!).toBe(0.5)
    expect(r.hi[2]! + r.lo[2]!).toBe(2)
  })

  it('componentwise mul carries cross terms f32 drops', () => {
    const x = 1 + 2 ** -30
    const r = cpu.fns.v_mul!(packV3([x, 2, 3]), packV3([x, 2, 3])) as {
      hi: number[]
      lo: number[]
    }
    expect(Math.abs(r.hi[0]! + r.lo[0]! - x * x)).toBeLessThan(2 ** -45)
    expect(Math.fround(Math.fround(x) * Math.fround(x))).toBe(1) // f32 loses it
  })

  it('dot accumulates in extended precision (catastrophic-cancellation vector)', () => {
    // a·b = 1e8·1 + 1·(−1e8) + 0.5·1 = 0.5 — f32 dot loses the tail entirely.
    const a: [number, number, number] = [1e8, 1, 0.5]
    const b: [number, number, number] = [1, -1e8, 1]
    expect(sum(cpu.fns.v_dot!(packV3(a), packV3(b)))).toBe(0.5)
  })

  it('length matches the exact hypot past f32 precision', () => {
    const a: [number, number, number] = [3e7, 4e7, 0.25]
    const exact = Math.hypot(...a)
    const got = sum(cpu.fns.v_len!(packV3(a)))
    expect(Math.abs(got - exact)).toBeLessThan(exact * 2 ** -40)
  })

  it('abs preserves the lo word f32 loses', () => {
    const x = 1e8 + 0.5 // splits exactly: (1e8, 0.5)
    const r = cpu.fns.v_abs!(packV3([-x, 2 ** -30, -2])) as { hi: number[]; lo: number[] }
    expect(r.hi[0]! + r.lo[0]!).toBe(x)
    expect(r.hi[1]! + r.lo[1]!).toBe(2 ** -30)
    expect(r.hi[2]! + r.lo[2]!).toBe(2)
    expect(Math.fround(Math.abs(Math.fround(-x)))).toBe(1e8) // f32 loses the 0.5
  })

  it('min breaks per-lane ties through the lo word (invisible to f32)', () => {
    const lo3 = Math.fround(0.3)
    const lo4 = Math.fround(0.4)
    // lane 0: hi ties at 1e8, lo decides; lane 1: plain; lane 2: negatives.
    const a: [number, number, number] = [1e8 + lo3, 1, -6]
    const b: [number, number, number] = [1e8 + lo4, 2, -5]
    const r = cpu.fns.v_min!(packV3(a), packV3(b)) as { hi: number[]; lo: number[] }
    expect(r.hi[0]! + r.lo[0]!).toBe(1e8 + lo3)
    expect(r.hi[1]! + r.lo[1]!).toBe(1)
    expect(r.hi[2]! + r.lo[2]!).toBe(-6)
    expect(Math.fround(1e8 + lo3)).toBe(Math.fround(1e8 + lo4)) // f32 cannot order them
  })

  it('mix lands on midpoints f32 collapses', () => {
    const b = 1e8 + 0.5
    const r = cpu.fns.v_mix!(packV3([0, 0, 0]), packV3([b, 2, 4]), 0.5) as {
      hi: number[]
      lo: number[]
    }
    expect(r.hi[0]! + r.lo[0]!).toBe(5e7 + 0.25)
    expect(r.hi[1]! + r.lo[1]!).toBe(1)
    expect(Math.fround(Math.fround(b) * 0.5)).toBe(5e7) // f32 drops the 0.25
  })

  it('floor/fract recover the sub-integer part at 1e8 (f32 renders it 0)', () => {
    const frac = Math.fround(0.7)
    const a: [number, number, number] = [1e8 + frac, -1.5, 2]
    const rFloor = cpu.fns.v_floor!(packV3(a)) as { hi: number[]; lo: number[] }
    expect(rFloor.hi[0]! + rFloor.lo[0]!).toBe(1e8)
    expect(rFloor.hi[1]! + rFloor.lo[1]!).toBe(-2)
    const rFract = cpu.fns.v_fract!(packV3(a)) as { hi: number[]; lo: number[] }
    expect(rFract.hi[0]! + rFract.lo[0]!).toBe(frac)
    expect(rFract.hi[1]! + rFract.lo[1]!).toBe(0.5)
    expect(Math.fround(Math.fround(1e8 + frac) - Math.floor(Math.fround(1e8 + frac)))).toBe(0)
  })

  it('normalize holds unit length to df64 precision (f32 sits ~2^-23)', () => {
    const a: [number, number, number] = [3e7, 4e7, 0.25]
    const exact = Math.hypot(...a)
    const r = cpu.fns.v_norm!(packV3(a)) as { hi: number[]; lo: number[] }
    let sq = 0
    for (let i = 0; i < 3; i++) {
      const lane = r.hi[i]! + r.lo[i]!
      expect(Math.abs(lane - a[i]! / exact)).toBeLessThanOrEqual(Math.abs(a[i]! / exact) * 2 ** -40)
      sq += lane * lane
    }
    expect(Math.abs(Math.sqrt(sq) - 1)).toBeLessThan(2 ** -40)
  })
})

describe('vec64 metamorphic gate — oracle(fp64Lower(m)) ≈ oracle(m)', () => {
  const authored = compileModule(m)
  const lowered = compileModule(fp64Lower(m))

  it('componentwise + reductions agree across the two paths', () => {
    const a: [number, number, number] = [123456.789, -0.000123, 9876.5]
    const b: [number, number, number] = [Math.PI, Math.E, -12345.678]
    const exactDot = authored.fns.v_dot!(a, b) as number
    const lowDot = sum(lowered.fns.v_dot!(packV3(a), packV3(b)))
    expect(Math.abs(lowDot - exactDot)).toBeLessThanOrEqual(Math.abs(exactDot) * 2 ** -40)
    const exactAdd = authored.fns.v_add!(a, b) as number[]
    const lowAdd = lowered.fns.v_add!(packV3(a), packV3(b)) as { hi: number[]; lo: number[] }
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(lowAdd.hi[i]! + lowAdd.lo[i]! - exactAdd[i]!)).toBeLessThanOrEqual(
        Math.abs(exactAdd[i]!) * 2 ** -40,
      )
    }
  })

  it('componentwise builtins agree across the two paths', () => {
    const a: [number, number, number] = [-123456.789, 0.000123, -9876.5]
    const b: [number, number, number] = [Math.PI, -Math.E, 12345.678]
    const perLane = (
      name: string,
      args: CpuValue[],
      lowArgs: CpuValue[],
    ): { exact: number[]; low: { hi: number[]; lo: number[] } } => ({
      exact: authored.fns[name]!(...args) as number[],
      low: lowered.fns[name]!(...lowArgs) as { hi: number[]; lo: number[] },
    })
    for (const [name, args, lowArgs] of [
      ['v_abs', [a], [packV3(a)]],
      ['v_min', [a, b], [packV3(a), packV3(b)]],
      ['v_mix', [a, b, 0.25], [packV3(a), packV3(b), 0.25]],
      ['v_fract', [a], [packV3(a)]],
      ['v_floor', [a], [packV3(a)]],
      ['v_norm', [a], [packV3(a)]],
    ] as [string, CpuValue[], CpuValue[]][]) {
      const { exact, low } = perLane(name, args, lowArgs)
      for (let i = 0; i < 3; i++) {
        const got = low.hi[i]! + low.lo[i]!
        expect(Math.abs(got - exact[i]!), `${name} lane ${i}`).toBeLessThanOrEqual(
          Math.max(Math.abs(exact[i]!), 1) * 2 ** -40,
        )
      }
    }
  })
})
