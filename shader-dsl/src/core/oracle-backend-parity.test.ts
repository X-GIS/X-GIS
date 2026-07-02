import { describe, it, expect } from 'vitest'
import { fn, module, f32, vec4, u32T, f32T, vec4fT, vec2fT } from './ir'
import type { FuncDecl, ShaderType, Stmt } from './ir'
import { compileModule, ORACLE_BUILTIN_NAMES, ORACLE_GPU_STUB_NAMES } from './oracle'
import { INTRINSICS } from './intrinsics'
import { pow, fract, round, unpack4x8unorm, pack4x8unorm, bitcastU32 } from './ir'

// ═══ #763 Phase O — the CPU oracle is a backend too ═══
//
// The parity-gate methodology (GPU vs f64 mirror) rests on the oracle being
// boring: same intrinsic set, fail-loud on what it cannot compute, never a
// plausible-wrong value. compileModule is PRODUCTION-used (map cpu-projections).

const mat3T: ShaderType = { kind: 'mat', n: 3 } as unknown as ShaderType
const vec3T: ShaderType = { kind: 'vec', n: 3, elem: 'f32' } as ShaderType

/** Hand-built decl: `fn f(m: mat3, v: vec3) -> vec3 { return m <bop> v }` —
 *  the IR-literal shape (no mat3 authoring surface exists; the oracle must
 *  still be correct or loud on it). */
const matBinFn = (name: string, aT: ShaderType, bT: ShaderType, retT: ShaderType): FuncDecl => ({
  name,
  params: [{ name: 'a', type: aT }, { name: 'b', type: bT }],
  ret: retT,
  body: [{
    s: 'return',
    expr: {
      op: 'binop', bop: '*', type: retT,
      a: { op: 'param', type: aT, name: 'a' },
      b: { op: 'param', type: bT, name: 'b' },
    },
  } as unknown as Stmt],
})

describe('#763 O — oracle backend parity', () => {
  it('O1: pow / fract / unpack4x8unorm / bitcastU32 evaluate on the CPU', () => {
    const f = fn('o1', { x: f32T }, ({ x }) => {
      const p = pow(x, f32(10))            // 2^10 = 1024
      const fr = fract(f32(1.25))          // 0.25
      const rt = unpack4x8unorm(pack4x8unorm(vec4(1, 0, 0.5, 1)))
      const bc = bitcastU32(f32(1))        // 0x3f800000
      return vec4(p, fr, rt.z.mul(255), bitcastU32(f32(0)).add(bc).bitAnd(bc).eq(bc).select(f32(1), f32(0)))
    })
    const m = compileModule(module({ funcs: [f] }))
    const out = m.fns['o1']!(2) as number[]
    expect(out[0]).toBe(1024)
    expect(out[1]).toBeCloseTo(0.25, 12)
    expect(out[2]).toBeCloseTo(128, 6) // 0.5 → byte 128 → *255/255
    expect(out[3]).toBe(1)             // bitcastU32(1.0) === 0x3f800000 path exercised
  })

  it('O2: mat3 × vec3 is dimension-correct (the mat4-hardcoded form returned NaN)', () => {
    // Column-major identity with a translation-free 3x3: scale by [1,2,3] on the diagonal.
    const decl = matBinFn('o2', mat3T, vec3T, vec3T)
    const m = compileModule(module({ funcs: [decl] }))
    const diag = [1, 0, 0, 0, 2, 0, 0, 0, 3] // columns of diag(1,2,3)
    const out = m.fns['o2']!(diag, [10, 20, 30]) as number[]
    expect(out).toEqual([10, 40, 90]) // fail-before: [NaN, NaN, NaN]
  })

  it('O2: mat × mat and vec × mat fail LOUD instead of element-wise-wrong', () => {
    const mm = compileModule(module({ funcs: [matBinFn('o2mm', mat3T, mat3T, mat3T)] }))
    expect(() => mm.fns['o2mm']!([1, 0, 0, 0, 1, 0, 0, 0, 1], [1, 0, 0, 0, 1, 0, 0, 0, 1]))
      .toThrow(/mat\*mat is not implemented/)
    const vm = compileModule(module({ funcs: [matBinFn('o2vm', vec3T, mat3T, vec3T)] }))
    expect(() => vm.fns['o2vm']!([1, 2, 3], [1, 0, 0, 0, 1, 0, 0, 0, 1]))
      .toThrow(/vec\*mat/)
  })

  it('O3: GPU-only stubs throw by default, return placeholders only under opt-in', () => {
    const tex = { op: 'param', type: { kind: 'texture', dim: '2d' }, name: 't' }
    const smp = { op: 'param', type: { kind: 'sampler' }, name: 's' }
    const decl: FuncDecl = {
      name: 'o3',
      params: [
        { name: 't', type: tex.type as ShaderType },
        { name: 's', type: smp.type as ShaderType },
        { name: 'uv', type: vec2fT },
      ],
      ret: vec4fT,
      body: [{
        s: 'return',
        expr: { op: 'call', fn: 'textureSample', type: vec4fT, args: [tex, smp, { op: 'param', type: vec2fT, name: 'uv' }] },
      } as unknown as Stmt],
    }
    const strict = compileModule(module({ funcs: [decl] }))
    expect(() => strict.fns['o3']!(0, 0, [0.5, 0.5])).toThrow(/GPU-only/)
    const loose = compileModule(module({ funcs: [decl] }), { gpuStubs: true })
    expect(loose.fns['o3']!(0, 0, [0.5, 0.5])).toEqual([0, 0, 0, 1])
  })

  it('O4: round is roundTiesToEven, not Math.round', () => {
    const f = fn('o4', { x: f32T }, ({ x }) => round(x))
    const m = compileModule(module({ funcs: [f] }))
    expect(m.fns['o4']!(2.5)).toBe(2)
    expect(m.fns['o4']!(3.5)).toBe(4)
    expect(m.fns['o4']!(-2.5)).toBe(-2)
  })

  it('O5: every catalogued intrinsic has a CPU twin or is a declared GPU stub', () => {
    // Covered by a dedicated Expr op in the oracle, not a call dispatch:
    // `select` is the 'select' Expr case (evalExpr) — it can never arrive as a call.
    const EXPR_COVERED = new Set(['select'])
    // GLSL-only synthetic: created by lowerStorageToDataTexture INSIDE the GLSL
    // emit path — compileModule never sees it (and `unknown fn` would fail loud).
    const GLSL_SYNTHETIC = new Set(['storageFetchF32'])
    const catalogued = Object.keys(INTRINSICS)
    const missing = catalogued.filter(
      (name) => !ORACLE_BUILTIN_NAMES.has(name) && !ORACLE_GPU_STUB_NAMES.has(name)
        && !EXPR_COVERED.has(name) && !GLSL_SYNTHETIC.has(name),
    )
    // A name landing here means: it emits on WGSL/GLSL but throws `unknown fn`
    // at first CPU use. Add it to BUILTINS (pure math) or GPU_STUBS (documented).
    expect(missing).toEqual([])
  })

  it('O6: assignOp threads the i32 arithmetic-shift flag', () => {
    const i32T: ShaderType = { kind: 'scalar', scalar: 'i32' } as ShaderType
    const decl: FuncDecl = {
      name: 'o6',
      params: [{ name: 'x', type: i32T }],
      ret: i32T,
      body: [
        { s: 'var', name: 'v', type: i32T, init: { op: 'param', type: i32T, name: 'x' } },
        { s: 'assignOp', target: { op: 'varref', type: i32T, name: 'v' }, bop: '>>', expr: { op: 'lit', type: u32T, value: 1 } },
        { s: 'return', expr: { op: 'varref', type: i32T, name: 'v' } },
      ] as unknown as Stmt[],
    }
    const m = compileModule(module({ funcs: [decl] }))
    expect(m.fns['o6']!(-8)).toBe(-4) // fail-before: logical shift → 2147483644
  })
})
