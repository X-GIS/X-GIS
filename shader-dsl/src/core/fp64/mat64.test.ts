// ═══ matNxN<f64> tests — authoring surface, lowering shapes, known answers ═══
//
// The matrix milestone of the fp64 feature: mat·vec / matmul / transpose over
// emulated doubles. A matNxN<f64> lowers to `struct DF64MatN { c0..c(N-1):
// DF64VecN }` (column-major) and the ops compose the SCALAR df64 EFTs — the same
// extended-precision accumulation dot()/length() use, so the known answers run
// under the SAME f32-rounding oracle as the scalar/vector suites.

import { describe, it, expect } from 'vitest'
import {
  fn,
  module,
  mat2f64T,
  mat3f64T,
  vec2f64T,
  vec3f64T,
  mat2f64,
  vec2f64,
  transformMat64,
  mulMat64,
  transpose64,
  typeKey,
  structT,
  type Expr,
  type ModuleDecl,
  type ShaderType,
} from '../ir'
import { compileModule, type CpuValue } from '../oracle'
import { fp64Lower } from '../passes/fp64-lower'
import { mapModuleExprs } from '../passes/opt/ir-transform'
import { wgslLayout } from '../reflect'
import { splitF64, FP64_GUARD_NAME, DF64_MAT_STRUCTS, DF64_VEC_STRUCTS } from './df64-lib'

// ── Authoring surface ──

describe('mat64 authoring surface', () => {
  it('constructors carry the matNxN<f64> key', () => {
    const m = mat2f64(vec2f64(1e8 + 0.5, 2), vec2f64(3, 4))
    expect(typeKey(m.type)).toBe('mat2x2<f64>')
  })

  it('mat·vec → vec64, matmul → mat64, transpose → mat64', () => {
    const m = mat2f64(vec2f64(1, 2), vec2f64(3, 4))
    const v = vec2f64(5, 6)
    expect(typeKey(transformMat64(m, v).type)).toBe('vec2<f64>')
    expect(typeKey(mulMat64(m, m).type)).toBe('mat2x2<f64>')
    expect(typeKey(transpose64(m).type)).toBe('mat2x2<f64>')
  })
})

// ── Lowering shapes ──

describe('mat64 lowering', () => {
  it('mat·vec lowers to df64_mN_matvec; DF64MatN + DF64VecN + guard injected', () => {
    const k = fn('mv', { m: mat2f64T, v: vec2f64T }, (p) => transformMat64(p.m, p.v))
    const lowered = fp64Lower(module({ funcs: [k] }))
    const names = lowered.funcs.map((f) => f.name)
    expect(names).toContain('df64_m2_matvec')
    expect(lowered.structs.some((s) => s.name === 'DF64Mat2')).toBe(true)
    expect(lowered.structs.some((s) => s.name === 'DF64Vec2')).toBe(true)
    // DF64VecN must be declared BEFORE the DF64MatN that nests it (GLSL needs it).
    expect(lowered.structs.findIndex((s) => s.name === 'DF64Vec2')).toBeLessThan(
      lowered.structs.findIndex((s) => s.name === 'DF64Mat2'),
    )
    expect(lowered.bindings.some((b) => b.name === FP64_GUARD_NAME)).toBe(true)
  })

  it('matmul pulls matvec transitively; transpose lowers to df64_mN_transpose', () => {
    const mul = fn('mm', { a: mat3f64T, b: mat3f64T }, (p) => mulMat64(p.a, p.b))
    const mulNames = fp64Lower(module({ funcs: [mul] })).funcs.map((f) => f.name)
    expect(mulNames).toContain('df64_m3_matmul')
    expect(mulNames).toContain('df64_m3_matvec') // matmul body calls matvec per column
    const t = fn('tr', { m: mat2f64T }, (p) => transpose64(p.m))
    expect(fp64Lower(module({ funcs: [t] })).funcs.map((f) => f.name)).toContain('df64_m2_transpose')
  })

  it('a reserved DF64Mat* struct name is rejected (SD0043)', () => {
    const k = fn('mv', { m: mat2f64T, v: vec2f64T }, (p) => transformMat64(p.m, p.v))
    const clash = module({
      structs: [{ name: 'DF64Mat2', fields: [{ name: 'c0', type: vec2f64T }] }],
      funcs: [k],
    })
    expect(() => fp64Lower(clash)).toThrow(/SD0043/)
  })

  it('a mat64 uniform field layout matches its lowered DF64MatN struct', () => {
    // The authored matN<f64> layout must equal the ACTUAL lowered DF64MatN
    // struct (from df64-lib's SoT), reflected through the same engine — so a
    // host packs the two identically. std430 only (mat2 std140 diverges WGSL/GL).
    const structs = new Map([
      ['DF64Vec2', DF64_VEC_STRUCTS.get(2)!],
      ['DF64Mat2', DF64_MAT_STRUCTS.get(2)!],
      ['DF64Vec3', DF64_VEC_STRUCTS.get(3)!],
      ['DF64Mat3', DF64_MAT_STRUCTS.get(3)!],
    ])
    for (const [matT, name] of [
      [mat2f64T, 'DF64Mat2'],
      [mat3f64T, 'DF64Mat3'],
    ] as const) {
      const authored = wgslLayout({ name: 'U', fields: [{ name: 'm', type: matT }] }, 'std430')
      const lowered = wgslLayout(
        { name: 'U', fields: [{ name: 'm', type: structT(name) }] },
        'std430',
        structs,
      )
      expect(authored.size).toBe(lowered.size)
      expect(authored.align).toBe(lowered.align)
    }
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
    fn('m2_vec', { m: mat2f64T, v: vec2f64T }, (p) => transformMat64(p.m, p.v)),
    fn('m2_mul', { a: mat2f64T, b: mat2f64T }, (p) => mulMat64(p.a, p.b)),
    fn('m2_t', { m: mat2f64T }, (p) => transpose64(p.m)),
    fn('m3_vec', { m: mat3f64T, v: vec3f64T }, (p) => transformMat64(p.m, p.v)),
  ],
})
const cpu = f32Oracle(m)

// ── Host packing (column-major) of mat/vec f64 into the lowered struct shapes ──

type Pair = [number, number]
const packVec = (v: number[]): CpuValue => {
  const parts = v.map(splitF64)
  return { hi: parts.map((p) => p[0]), lo: parts.map((p) => p[1]) }
}
/** Column-major mat64 → { c0: {hi,lo}, c1: {hi,lo}, … }. */
const packMat = (cols: number[][]): CpuValue =>
  Object.fromEntries(cols.map((c, j) => [`c${j}`, packVec(c)])) as CpuValue
/** Flat column-major mat64 for the AUTHORED (native-f64 number[]) oracle path. */
const flatMat = (cols: number[][]): number[] => cols.flat()
const sumVec = (r: CpuValue): number[] => {
  const { hi, lo } = r as { hi: number[]; lo: number[] }
  return hi.map((h, i) => h + lo[i]!)
}
const sumMat = (r: CpuValue, n: number): number[] => {
  const o = r as Record<string, CpuValue>
  return Array.from({ length: n }, (_, j) => sumVec(o[`c${j}`]!)).flat()
}

describe('mat64 known answers (f32-rounding oracle)', () => {
  it('mat·vec accumulates in extended precision (cancellation f32 loses)', () => {
    // lane0 = c0.x·v0 + c1.x·v1 = 1e8·1 + 1·(−(1e8−0.5)) = 0.5 — f32 collapses to 0.
    const cols: number[][] = [
      [1e8, 2], // c0
      [1, 3], // c1
    ]
    const v: number[] = [1, -(1e8 - 0.5)]
    const r = sumVec(cpu.fns.m2_vec!(packMat(cols), packVec(v)))
    expect(r[0]).toBe(0.5)
    // lane1 = 2·1 + 3·(−(1e8−0.5)) = 2 − 3e8 + 1.5 = 3.5 − 3e8
    expect(r[1]).toBeCloseTo(3.5 - 3e8, 3)
    // f32 mat·vec loses lane0's 0.5 tail entirely.
    expect(Math.fround(Math.fround(1e8) * 1 + Math.fround(1) * Math.fround(-(1e8 - 0.5)))).toBe(0)
  })

  it('transpose swaps off-diagonal columns exactly (lo word preserved)', () => {
    // M = [[1e8+0.5, 2],[3, 4]] column-major cols c0=(1e8+0.5,3), c1=(2,4).
    // Mᵀ cols: c0=(1e8+0.5,2), c1=(3,4).
    const cols: number[][] = [
      [1e8 + 0.5, 3],
      [2, 4],
    ]
    const r = sumMat(cpu.fns.m2_t!(packMat(cols)), 2)
    expect(r).toEqual([1e8 + 0.5, 2, 3, 4])
  })
})

describe('mat64 metamorphic gate — oracle(fp64Lower(m)) ≈ oracle(m)', () => {
  const authored = compileModule(m)
  const lowered = compileModule(fp64Lower(m))
  const close = (a: number, b: number, label: string): void =>
    expect(Math.abs(a - b), label).toBeLessThanOrEqual(Math.max(Math.abs(b), 1) * 2 ** -40)

  it('mat·vec agrees across the two paths (mat2 + mat3)', () => {
    const c2: number[][] = [
      [123456.789, -0.000123],
      [Math.PI, 9876.5],
    ]
    const v2: Pair = [Math.E, -12345.678]
    const exact2 = authored.fns.m2_vec!(flatMat(c2), v2) as number[]
    const low2 = sumVec(lowered.fns.m2_vec!(packMat(c2), packVec(v2)))
    exact2.forEach((e, i) => close(low2[i]!, e, `m2_vec[${i}]`))

    const c3: number[][] = [
      [1.5, -2.25, 3.125],
      [Math.SQRT2, 1e6 + 0.5, -7],
      [0.001, -1e5, Math.LN2],
    ]
    const v3: number[] = [Math.PI, -Math.E, 42.5]
    const exact3 = authored.fns.m3_vec!(flatMat(c3), v3) as number[]
    const low3 = sumVec(lowered.fns.m3_vec!(packMat(c3), packVec(v3)))
    exact3.forEach((e, i) => close(low3[i]!, e, `m3_vec[${i}]`))
  })

  it('matmul agrees across the two paths', () => {
    const a: number[][] = [
      [1.25, -3.5],
      [Math.PI, 2048.5],
    ]
    const b: number[][] = [
      [Math.E, 0.125],
      [-17.5, Math.SQRT2],
    ]
    const exact = authored.fns.m2_mul!(flatMat(a), flatMat(b)) as number[]
    const low = sumMat(lowered.fns.m2_mul!(packMat(a), packMat(b)), 2)
    exact.forEach((e, i) => close(low[i]!, e, `m2_mul[${i}]`))
  })

  it('transpose agrees across the two paths', () => {
    const cols: number[][] = [
      [11.5, -22.25],
      [Math.PI, 44.125],
    ]
    const exact = authored.fns.m2_t!(flatMat(cols)) as number[]
    const low = sumMat(lowered.fns.m2_t!(packMat(cols)), 2)
    exact.forEach((e, i) => close(low[i]!, e, `m2_t[${i}]`))
  })
})
