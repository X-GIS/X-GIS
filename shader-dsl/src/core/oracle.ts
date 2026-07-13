// ═══ Shader DSL — CPU (f64) backend ═══
//
// Tree-walk interpreter over the SAME IR the WGSL backend emits. This is the
// generated replacement for the hand-maintained projection-wgsl-mirror.ts:
// it runs the identical operation tree in f64 with Math.* (no fround), so it
// reproduces the mirror's numbers (AC2-spike (a): ≤1mm vs canonical).
//
// Module-level consts use their cpuValue (full-precision Math.PI / Math.PI/180)
// so the projection math matches the f64 mirror, while the WGSL backend emits
// the truncated shader constants — the two-tolerance reality, structural.
//
// Vectors are number[] (mutable, by reference so `p.x = …` assigns in place).
// Performance: tree-walk is ample for the tile-selection / raster / label
// consumers (O(hundreds) calls/frame); the perf-critical js-source backend
// (new Function) is a Phase-1 concern, not this.
// ─── CAVEAT — this is an f64 ALGEBRA oracle, NOT an f32-precision oracle ───
//
// Every value here is a JS f64 evaluated with Math.* and NO `fround`. That makes
// this backend structurally BLIND to the codebase's worst bug class: f32-precision
// loss on the GPU. It validates that the IR's ALGEBRA is correct (the right ops in
// the right order, matching the f64 mirror to ≤1mm), and nothing about what that
// algebra does once it is rounded to 32-bit floats per-vertex on a real driver.
//
// Concretely, it CANNOT catch:
//   • #392 (polygon fill displaced from outline) — fill arm fed f32 abs-degree
//     positions; the displacement is purely an f32-rounding artifact, invisible in f64.
//   • #360 (globe polar-cap black hole) — tail slot read as f32 garbage; the cull
//     fires only under f32 truncation, never in this interpreter.
// A CPU↔CPU pass here is therefore NOT evidence of GPU precision parity. The only
// real f32 differential is a headless-GPU gate that runs the EXECUTED shader and
// diffs it against this f64 result under an f32/truncated-const tolerance
// (today: playground/_shader-math-parity.spec.ts, ~100m, requires a WebGPU adapter).
// Treat this oracle as the ALGEBRA half of a two-oracle contract; the f32 half lives
// on the GPU.

import type { Expr, Stmt, ModuleDecl, BinOp, StructDecl } from './ir'
import { validate } from './passes/validate'
import { autoVars } from './passes/opt'

export type CpuValue = number | boolean | number[] | CpuStruct
export interface CpuStruct {
  [k: string]: CpuValue
}

interface Ctx {
  consts: Map<string, CpuValue>
  /** Specialization constants (#923) → their DEFAULT value. The CPU oracle is the
   *  un-specialized mirror: an override reads as its declared default (pipeline
   *  specialization is a GPU-driver concept with no CPU analogue). */
  overrides: Map<string, CpuValue>
  fns: Record<string, (...args: CpuValue[]) => CpuValue>
  bindings: Record<string, CpuValue>
  structs: Map<string, StructDecl>
  /** Opt-in GPU stubs (#763 O3): textureSample/fwidth return placeholder values
   *  instead of throwing. OFF by default — plausible-wrong is the worst failure
   *  mode for a reference backend. */
  gpuStubs: boolean
}

export interface CpuModule {
  fns: Record<string, (...args: CpuValue[]) => CpuValue>
  /** Inject a storage/uniform binding value (e.g. the shapes/segments arrays
   *  for sdf_shape) before invoking a fn that reads it. */
  setBinding(name: string, value: CpuValue): void
}

const FIELD_IDX: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 }

const isArr = Array.isArray

function scalarBin(bop: BinOp, a: number, b: number, isI32 = false): number {
  switch (bop) {
    case '+':
      return a + b
    case '-':
      return a - b
    case '*':
      return a * b
    case '/':
      return a / b
    case '%':
      return a % b
    // Bitwise — JS `& | ^ <<` produce int32; `>>> 0` normalises to nonnegative
    // u32 so cpu values stay in the unsigned range the shader expects. `>>`
    // uses JS `>>>` (logical shift) — point's per-feature flag dispatch is all
    // u32, and the codebase has no i32-arithmetic-shift use case.
    case '&':
      return (a & b) >>> 0
    case '|':
      return (a | b) >>> 0
    case '^':
      return (a ^ b) >>> 0
    case '<<':
      return (a << b) >>> 0
    // i32 uses arithmetic shift (sign-preserving JS `>>`); u32/untyped uses
    // logical `>>>`. No current shader does an i32 shift, so the i32 branch is
    // presently unreachable — this only removes the latent footgun.
    case '>>':
      return isI32 ? a >> b : a >>> b
  }
}

function applyBin(bop: BinOp, a: CpuValue, b: CpuValue, isI32 = false): CpuValue {
  if (isArr(a) && isArr(b))
    return a.map((x, i) => scalarBin(bop, x as number, b[i] as number, isI32))
  if (isArr(a)) return a.map((x) => scalarBin(bop, x as number, b as number, isI32))
  if (isArr(b)) return b.map((y) => scalarBin(bop, a as number, y as number, isI32))
  return scalarBin(bop, a as number, b as number, isI32)
}

// ── Builtins (vec-aware where WGSL is component-wise) ──
type Builtin = (...args: CpuValue[]) => CpuValue
const map1 =
  (f: (x: number) => number): Builtin =>
  (x) =>
    isArr(x) ? x.map((v) => f(v as number)) : f(x as number)

// WGSL / GLSL-ES `round` rounds halfway cases to the nearest EVEN integer, unlike
// JS `Math.round` (ties toward +∞). round(2.5)=2, round(3.5)=4, round(-2.5)=-2.
const roundTiesToEven = (x: number): number => {
  const f = Math.floor(x),
    d = x - f
  if (d < 0.5) return f
  if (d > 0.5) return f + 1
  return f % 2 === 0 ? f : f + 1
}

const BUILTINS: Record<string, Builtin> = {
  sin: map1(Math.sin),
  cos: map1(Math.cos),
  tan: map1(Math.tan),
  asin: map1(Math.asin),
  acos: map1(Math.acos),
  atan: map1(Math.atan),
  exp: map1(Math.exp),
  log: map1(Math.log),
  log2: map1(Math.log2),
  sqrt: map1(Math.sqrt),
  exp2: map1((x) => 2 ** x),
  inverseSqrt: map1((x) => 1 / Math.sqrt(x)),
  trunc: map1(Math.trunc),
  round: map1(roundTiesToEven),
  floor: map1(Math.floor),
  ceil: map1(Math.ceil),
  abs: map1(Math.abs),
  sign: map1(Math.sign),
  radians: map1((d) => (d * Math.PI) / 180),
  degrees: map1((r) => (r * 180) / Math.PI),
  atan2: (y, x) => Math.atan2(y as number, x as number),
  // mod(x, y) — FLOOR-mod, matching the registry spelling on both targets
  // (WGSL x − y·⌊x/y⌋, GLSL mod()). Deliberately NOT JS `%` (trunc-mod).
  // Component-wise; y may be a scalar broadcast over a vector x.
  mod: (x, y) => {
    const fm = (a: number, b: number): number => a - b * Math.floor(a / b)
    return isArr(x)
      ? (x as number[]).map((v, i) =>
          fm(v as number, isArr(y) ? ((y as number[])[i] as number) : (y as number)),
        )
      : fm(x as number, y as number)
  },
  min: (a, b) =>
    isArr(a) || isArr(b) ? applyMinMax(Math.min, a, b) : Math.min(a as number, b as number),
  max: (a, b) =>
    isArr(a) || isArr(b) ? applyMinMax(Math.max, a, b) : Math.max(a as number, b as number),
  // clamp ordering mirrors projection-wgsl-mirror.ts: max(lo, min(hi, x)).
  clamp: (x, lo, hi) => clampVal(x, lo, hi),
  mix: (a, b, t) => mixVal(a, b, t),
  // smoothstep is type-enforced scalar by the builder (node.ts:230 — all args + result
  // Node<ScalarKey>|number|f32), so no vector path is reachable here.
  smoothstep: (e0, e1, x) => {
    const t = clampVal(
      ((x as number) - (e0 as number)) / ((e1 as number) - (e0 as number)),
      0,
      1,
    ) as number
    return t * t * (3 - 2 * t)
  },
  // step(edge, x) — component-wise; edge may be a scalar broadcast over a vector x.
  step: (edge, x) => {
    const s = (e: number, v: number): number => (v < e ? 0 : 1)
    return isArr(x)
      ? (x as number[]).map((v, i) =>
          s(isArr(edge) ? (edge[i] as number) : (edge as number), v as number),
        )
      : s(edge as number, x as number)
  },
  length: (v) => Math.sqrt((v as number[]).reduce((s, c) => s + (c as number) * (c as number), 0)),
  dot: (a, b) =>
    (a as number[]).reduce((s, c, i) => s + (c as number) * ((b as number[])[i] as number), 0),
  distance: (a, b) =>
    Math.sqrt(
      (a as number[]).reduce((s, c, i) => {
        const d = (c as number) - ((b as number[])[i] as number)
        return s + d * d
      }, 0),
    ),
  normalize: (v) => {
    const a = v as number[]
    const l = Math.sqrt(a.reduce((s, c) => s + (c as number) * (c as number), 0))
    return a.map((c) => (c as number) / l)
  },
  cross: (a, b) => {
    const u = a as number[],
      w = b as number[]
    return [
      u[1]! * w[2]! - u[2]! * w[1]!,
      u[2]! * w[0]! - u[0]! * w[2]!,
      u[0]! * w[1]! - u[1]! * w[0]!,
    ]
  },
  // transpose(M) — a column-major n² matrix (used by the mat64 authoring path;
  // n is recovered from the flat length). Native for f32 matrices too.
  transpose: (m) => matTranspose(m as number[]),
  f32: (x) => Number(x),
  // toF64 widen — a no-op here: the oracle evaluates f64 natively as a JS
  // number (JS numbers ARE f64), which is why compileModule deliberately does
  // NOT run fp64Lower. `oracle(fp64Lower(m)) ≈ oracle(m)` is the metamorphic
  // gate on that pass (EFT error terms are exactly 0 in exact arithmetic).
  f64: (x) => Number(x),
  // The anti-fast-math guard value in LOWERED modules — semantically exactly
  // 1.0 (on the GPU it is a texel fetch, opaque to shader compilers; here it
  // is just the number, so the f32-rounding test oracle runs the same IR).
  f64Guard: () => 1,
  // hi/lo pair ↔ f64 (the DSFUN lane bridge): natively a sum / a fround split.
  f64FromParts: (hi, lo) => (hi as number) + (lo as number),
  f64Parts: (x) => {
    const hi = Math.fround(x as number)
    return [hi, Math.fround((x as number) - hi)]
  },
  i32: (x) => Math.trunc(x as number),
  u32: (x) => Math.trunc(x as number) >>> 0,
  // #763 O1 — pure-math builtins the catalogue claims portable but the oracle
  // lacked (a shader using them compiled + emitted on both GPU targets, then
  // threw `unknown fn` at first CPU use — and compileModule is production-used).
  pow: (a, b) =>
    isArr(a)
      ? (a as number[]).map((x, i) =>
          Math.pow(x as number, isArr(b) ? ((b as number[])[i] as number) : (b as number)),
        )
      : Math.pow(a as number, b as number),
  fract: map1((x) => x - Math.floor(x)),
  // fma(a, b, c) = a·b + c with a SINGLE rounding. For f32 operands the product
  // a·b is EXACT in a JS double (24+24 = 48 ≤ 53 significand bits), so
  // fround(a·b + c) is the correctly-rounded f32 fma up to the double-rounding
  // tail of the f64 add — beyond every tolerance the suites assert. Scalars only
  // (the DSL surface types fma over scalars; component-wise use maps at the IR).
  fma: (a, b, c) => Math.fround((a as number) * (b as number) + (c as number)),
  // unpack u32 RGBA8 → vec4<f32> in [0,1]; low byte → component 0 (pack4x8unorm inverse).
  unpack4x8unorm: (u) => {
    const n = (u as number) >>> 0
    return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].map((b) => b / 255)
  },
  // f32 bit-pattern reinterpreted as u32 (WGSL bitcast<u32> / GLSL floatBitsToUint).
  bitcastU32: (x) => {
    _bitcastView.setFloat32(0, Math.fround(x as number), true)
    return _bitcastView.getUint32(0, true)
  },
  // u32 bit-pattern reinterpreted as f32 (WGSL bitcast<f32> / GLSL uintBitsToFloat).
  bitcastF32: (x) => {
    _bitcastView.setUint32(0, (x as number) >>> 0, true)
    return _bitcastView.getFloat32(0, true)
  },
  // pack a vec4<f32> (each in [0,1]) into u32 RGBA8; component 0 → low byte.
  pack4x8unorm: (v) => {
    const a = v as number[]
    const q = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * 255) & 0xff
    return (q(a[0]) | (q(a[1]) << 8) | (q(a[2]) << 16) | (q(a[3]) << 24)) >>> 0
  },
}

const _bitcastView = new DataView(new ArrayBuffer(4))

// GPU-only stubs (#763 O3). textureSample needs the GPU's sampler/atlas; fwidth
// needs neighbouring fragments — neither is computable in this per-invocation
// interpreter. Evaluating one THROWS unless compileModule was given
// `{ gpuStubs: true }`: a silent [0,0,0,1] / 0 is a plausible-wrong value, the
// worst failure mode for a reference backend.
const GPU_STUBS: Record<string, Builtin> = {
  textureSample: () => [0, 0, 0, 1],
  fwidth: () => 0,
  dpdx: () => 0,
  dpdy: () => 0,
  textureLoad: () => [0, 0, 0, 1],
  textureDimensions: () => [1, 1], // 1×1, not 0×0 — a divide-by-dimensions stays finite
}

/** Test-only surfaces (#763 O5): the oracle's builtin coverage, pinned against the
 *  intrinsic catalogue so a new portable intrinsic cannot ship without a CPU twin. */
export const ORACLE_BUILTIN_NAMES: ReadonlySet<string> = new Set(Object.keys(BUILTINS))
export const ORACLE_GPU_STUB_NAMES: ReadonlySet<string> = new Set(Object.keys(GPU_STUBS))

function applyMinMax(f: (a: number, b: number) => number, a: CpuValue, b: CpuValue): number[] {
  if (isArr(a) && isArr(b)) return a.map((x, i) => f(x as number, b[i] as number))
  if (isArr(a)) return a.map((x) => f(x as number, b as number))
  return (b as number[]).map((y) => f(a as number, y as number))
}
function clampVal(x: CpuValue, lo: CpuValue, hi: CpuValue): CpuValue {
  // Component-wise — lo/hi may be scalars (broadcast) or per-component vectors.
  if (isArr(x)) {
    const loA = isArr(lo) ? (lo as number[]) : null
    const hiA = isArr(hi) ? (hi as number[]) : null
    return (x as number[]).map((v, i) =>
      Math.max(
        loA ? (loA[i] as number) : (lo as number),
        Math.min(hiA ? (hiA[i] as number) : (hi as number), v as number),
      ),
    )
  }
  return Math.max(lo as number, Math.min(hi as number, x as number))
}
// Component-wise — any of a/b/t may be a scalar (broadcast) or a per-component vector,
// matching WGSL mix() semantics (including a vector interpolant t).
function mixVal(a: CpuValue, b: CpuValue, t: CpuValue): CpuValue {
  if (isArr(a) || isArr(b) || isArr(t)) {
    const n = (isArr(a) ? a : isArr(b) ? b : (t as number[])).length
    const at = (v: CpuValue, i: number): number => (isArr(v) ? (v[i] as number) : (v as number))
    return Array.from({ length: n }, (_, i) => at(a, i) + (at(b, i) - at(a, i)) * at(t, i))
  }
  return (a as number) + ((b as number) - (a as number)) * (t as number)
}

function zeroOf(type: { kind: string; n?: number }): CpuValue {
  // vec64 evaluates natively as a plain number[] (like vec — JS numbers ARE f64).
  if (type.kind === 'vec' || type.kind === 'vec64') return new Array(type.n as number).fill(0)
  if (type.kind === 'mat') return new Array((type.n as number) * (type.n as number)).fill(0)
  if (type.kind === 'struct') return {} // fields populated by member assignments
  if (type.kind === 'scalar') return 0
  return 0
}

// matNxN (column-major) × vecN → vecN. result[row] = Σ_col m[col*N+row]*v[col].
// Dimension-generic (#763 O2) — the old hardcoded mat4 form read m[4+i]/m[8+i]/
// m[12+i] out of range on a mat2/mat3 and returned silent NaNs.
function matVec(m: number[], v: number[]): number[] {
  const n = v.length
  const out = new Array<number>(n).fill(0)
  for (let c = 0; c < n; c++) for (let r = 0; r < n; r++) out[r]! += m[c * n + r]! * v[c]!
  return out
}

// matNxN × matNxN (both column-major, flat n²). C[col*n+row] = Σ_k A[k*n+row]·B[col*n+k].
function matMul(a: number[], b: number[]): number[] {
  const n = Math.round(Math.sqrt(a.length))
  const out = new Array<number>(n * n).fill(0)
  for (let col = 0; col < n; col++)
    for (let row = 0; row < n; row++) {
      let s = 0
      for (let k = 0; k < n; k++) s += a[k * n + row]! * b[col * n + k]!
      out[col * n + row] = s
    }
  return out
}

// Transpose of a column-major n² matrix: out[i*n+j] = in[j*n+i].
function matTranspose(m: number[]): number[] {
  const n = Math.round(Math.sqrt(m.length))
  const out = new Array<number>(n * n).fill(0)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i * n + j] = m[j * n + i]!
  return out
}

function evalExpr(e: Expr, env: Map<string, CpuValue>, ctx: Ctx): CpuValue {
  switch (e.op) {
    case 'lit':
      return e.value
    case 'constref': {
      const v = ctx.consts.get(e.name)
      if (v === undefined) throw new Error(`shader-dsl/cpu: unknown const ${e.name}`)
      return v
    }
    case 'overrideref': {
      const v = ctx.overrides.get(e.name)
      if (v === undefined) throw new Error(`shader-dsl/cpu: unknown override ${e.name}`)
      return v
    }
    case 'param':
    case 'varref': {
      if (env.has(e.name)) return env.get(e.name) as CpuValue
      if (e.name in ctx.bindings) return ctx.bindings[e.name]
      throw new Error(`shader-dsl/cpu: unbound ${e.name}`)
    }
    case 'binop': {
      const av = evalExpr(e.a, env, ctx),
        bv = evalExpr(e.b, env, ctx)
      // mat * vec (column-major) — the MVP transform. Dispatched by the
      // operand's static type since values are type-blind number[] at runtime.
      if (
        e.bop === '*' &&
        e.a.type.kind === 'mat' &&
        (e.b.type.kind === 'vec' || e.b.type.kind === 'vec64')
      ) {
        return matVec(av as number[], bv as number[])
      }
      // A real column-major matrix product — needed for the mat64 (emulated
      // double) matmul path, whose metamorphic gate evaluates the AUTHORED
      // module here. (The native-mat*mat case stays supported by the same code.)
      if (e.bop === '*' && e.a.type.kind === 'mat' && e.b.type.kind === 'mat') {
        return matMul(av as number[], bv as number[])
      }
      if (e.bop === '*' && e.a.type.kind === 'vec' && e.b.type.kind === 'mat') {
        throw new Error(
          'shader-dsl/cpu: vec*mat (row-vector form) is not implemented — use mat*vec',
        )
      }
      const i32Op = e.a.type.kind === 'scalar' && e.a.type.scalar === 'i32'
      return applyBin(e.bop, av, bv, i32Op)
    }
    case 'unop': {
      const a = evalExpr(e.a, env, ctx)
      return isArr(a) ? a.map((v) => -(v as number)) : -(a as number)
    }
    case 'compare': {
      const a = evalExpr(e.a, env, ctx) as number,
        b = evalExpr(e.b, env, ctx) as number
      // == / != reflect f32 rounding when comparing f32 operands — the GPU
      // computes f32, so exact f64 equality silently disagrees with it on
      // equality branches (#13). Ordering ops keep f64 (rounding rarely flips an
      // inequality, and f64 is the stricter mirror for thresholds).
      const f32cmp = e.a.type.kind === 'scalar' && e.a.type.scalar === 'f32'
      switch (e.cop) {
        case '<':
          return a < b
        case '>':
          return a > b
        case '<=':
          return a <= b
        case '>=':
          return a >= b
        case '==':
          return f32cmp ? Math.fround(a) === Math.fround(b) : a === b
        case '!=':
          return f32cmp ? Math.fround(a) !== Math.fround(b) : a !== b
      }
    }
    // eslint-disable-next-line no-fallthrough
    case 'logical': {
      const a = evalExpr(e.a, env, ctx) as boolean
      if (e.lop === '&&') return a ? (evalExpr(e.b, env, ctx) as boolean) : false
      return a ? true : (evalExpr(e.b, env, ctx) as boolean)
    }
    case 'call': {
      const args = e.args.map((a) => evalExpr(a, env, ctx))
      const b = BUILTINS[e.fn]
      if (b) return b(...args)
      const stub = GPU_STUBS[e.fn]
      if (stub) {
        if (!ctx.gpuStubs) {
          throw new Error(
            `shader-dsl/cpu: '${e.fn}' is GPU-only and not computable here — pass compileModule(m, { gpuStubs: true }) to accept placeholder values (#763 O3)`,
          )
        }
        return stub(...args)
      }
      const user = ctx.fns[e.fn]
      if (user) return user(...args)
      throw new Error(`shader-dsl/cpu: unknown fn ${e.fn}`)
    }
    case 'member': {
      const base = evalExpr(e.base, env, ctx)
      if (isArr(base)) {
        // Multi-char swizzle (.rgb / .xy) → a new vector; single → a scalar.
        if (e.field.length > 1) return [...e.field].map((c) => base[FIELD_IDX[c]!] as number)
        return base[FIELD_IDX[e.field]] as CpuValue
      }
      return (base as Record<string, CpuValue>)[e.field]
    }
    case 'construct': {
      // Array literal: keep each element intact (array<vec2,N> → [[x,y],…]).
      if (e.type.kind === 'array') return e.args.map((a) => evalExpr(a, env, ctx)) as CpuValue
      // Struct constructor: `MyStruct(a, b, …)` → a field-keyed object in decl order (the
      // same shape the field-by-field `assign(out.f, …)` build produces).
      if (e.type.kind === 'struct') {
        const decl = ctx.structs.get(e.type.name)
        if (decl === undefined) throw new Error(`oracle: struct '${e.type.name}' not declared`)
        const obj: Record<string, CpuValue> = {}
        decl.fields.forEach((f, i) => {
          obj[f.name] = evalExpr(e.args[i]!, env, ctx)
        })
        return obj as CpuValue
      }
      // Vector constructor: flatten scalar/vec args into one component list.
      const out: number[] = []
      for (const a of e.args) {
        const v = evalExpr(a, env, ctx)
        if (isArr(v)) out.push(...(v as number[]))
        else out.push(v as number)
      }
      // WGSL splat: vecN<T>(singleScalar) fills all N components (e.g. vec3(0.5) = [0.5,0.5,0.5]).
      if ((e.type.kind === 'vec' || e.type.kind === 'vec64') && out.length === 1)
        return new Array(e.type.n as number).fill(out[0])
      return out
    }
    case 'select': {
      const c = evalExpr(e.cond, env, ctx) as boolean
      return c ? evalExpr(e.ifTrue, env, ctx) : evalExpr(e.ifFalse, env, ctx)
    }
    case 'index': {
      const base = evalExpr(e.base, env, ctx) as CpuValue[]
      return base[evalExpr(e.idx, env, ctx) as number]
    }
    case 'matchExpr': {
      // CPU semantics mirror the WGSL pre-emit lowering: evaluate the
      // scrutinee, find the matching case (by ===), return its value.
      // No fall-through. Default fires when no case matches.
      const sv = evalExpr(e.scrutinee, env, ctx) as number
      const hit = e.cases.find(([v]) => v === sv)
      return evalExpr(hit ? hit[1] : e.default, env, ctx)
    }
  }
}

function setLValue(target: Expr, value: CpuValue, env: Map<string, CpuValue>, ctx: Ctx): void {
  if (target.op === 'varref' || target.op === 'param') {
    env.set(target.name, value)
    return
  }
  if (target.op === 'member') {
    const base = evalExpr(target.base, env, ctx)
    if (isArr(base)) base[FIELD_IDX[target.field]] = value as number
    else (base as Record<string, CpuValue>)[target.field] = value
    return
  }
  if (target.op === 'index') {
    const base = evalExpr(target.base, env, ctx) as CpuValue[]
    base[evalExpr(target.idx, env, ctx) as number] = value
    return
  }
  throw new Error(`shader-dsl/cpu: bad assignment target ${target.op}`)
}

type Signal =
  | { kind: 'normal' }
  | { kind: 'return'; value: CpuValue | undefined }
  | { kind: 'break' }
  | { kind: 'continue' }
  | { kind: 'discard' }
const NORMAL: Signal = { kind: 'normal' }

// One flat env per function call (no per-block child scope). This is safe
// because the ONLY way to reference a binding is the Node returned by
// b.let()/b.var()/forRange — the TS host already scopes those lexically, so a
// `var` declared in one branch can't be read from another. (A future
// "read a binding by name" API would expose the divergence from WGSL block
// scoping; don't add one without per-block scopes here.)
function execBody(body: readonly Stmt[], env: Map<string, CpuValue>, ctx: Ctx): Signal {
  for (const s of body) {
    switch (s.s) {
      case 'let':
        env.set(s.name, evalExpr(s.expr, env, ctx))
        break
      case 'var':
        env.set(s.name, s.init ? evalExpr(s.init, env, ctx) : zeroOf(s.type))
        break
      case 'assign':
        setLValue(s.target, evalExpr(s.expr, env, ctx), env, ctx)
        break
      case 'assignOp': {
        const cur = evalExpr(s.target, env, ctx)
        // #763 O6 — thread the i32 flag exactly as the binop path does
        // (oracle.ts binop case): `x >>= y` on an i32 target is an ARITHMETIC
        // shift; the flag was applied to one of the two eval sites only.
        const i32Op = s.target.type.kind === 'scalar' && s.target.type.scalar === 'i32'
        setLValue(s.target, applyBin(s.bop, cur, evalExpr(s.expr, env, ctx), i32Op), env, ctx)
        break
      }
      case 'return':
        return { kind: 'return', value: s.expr ? evalExpr(s.expr, env, ctx) : undefined }
      case 'break':
        return { kind: 'break' }
      case 'continue':
        return { kind: 'continue' }
      case 'discard':
        return { kind: 'discard' }
      case 'if': {
        let taken = false
        for (const arm of s.arms) {
          if (evalExpr(arm.cond, env, ctx)) {
            const r = execBody(arm.body, env, ctx)
            if (r.kind !== 'normal') return r
            taken = true
            break
          }
        }
        if (!taken && s.elseBody) {
          const r = execBody(s.elseBody, env, ctx)
          if (r.kind !== 'normal') return r
        }
        break
      }
      case 'for': {
        execBody([s.init], env, ctx)
        while (evalExpr(s.cond, env, ctx)) {
          const r = execBody(s.body, env, ctx)
          if (r.kind === 'break') break
          if (r.kind === 'return' || r.kind === 'discard') return r
          // 'continue' jumps straight to the update + next condition eval —
          // the body short-circuit already returned, just don't propagate.
          execBody([s.update], env, ctx)
        }
        break
      }
      case 'switch': {
        const v = evalExpr(s.scrut, env, ctx) as number
        const hit = s.cases.find((c) => c.value === v)
        const chosen = hit ? hit.body : s.defaultBody
        if (chosen) {
          const r = execBody(chosen, env, ctx)
          if (r.kind === 'return' || r.kind === 'discard') return r
          // 'break' inside a switch case terminates the case (already exits body)
        }
        break
      }
      case 'placeholder': {
        // Phase 2.5 US-007 — the polygon composer (emitPolygonWgsl)
        // MUST swap every placeholder Stmt before emit. If one reaches
        // CPU eval, the composer forgot to splice — fail loudly rather
        // than silently no-op (the WGSL backend emits a defensive
        // comment, but on CPU there's no analogue and a silent
        // missing-return is much harder to localise).
        throw new Error(
          `shader-dsl/cpu: placeholder Stmt reached CPU backend — composer forgot to splice tag=${s.tag}`,
        )
      }
      case 'raw': {
        // Phase 2 PR 2e.B.2 — raw WGSL passthrough is GPU-only; it has no
        // CPU evaluation. Reaching here means a raw Stmt was placed on a
        // shader path that also runs through the CPU mirror (cpu-projections
        // / compute eval), which is a composition bug — fail loudly.
        throw new Error(
          'shader-dsl/cpu: raw WGSL Stmt reached CPU backend — raw passthrough is GPU-only',
        )
      }
    }
  }
  return NORMAL
}

export function compileModule(m: ModuleDecl, opts?: { gpuStubs?: boolean }): CpuModule {
  // Same validation gate as the WGSL/GLSL writers — the oracle is the third
  // backend over the same IR, so it must reject a structurally-invalid module.
  validate(m)
  // Materialise auto-vars (plain `const x = …; assign(x, …)`) into real `var` bindings, exactly
  // as the WGSL backend does, so the CPU mirror evaluates the same assignable lvalues.
  m = autoVars(m)
  const ctx: Ctx = {
    consts: new Map<string, CpuValue>(),
    // #923 — an override reads as its default on the CPU mirror.
    overrides: new Map<string, CpuValue>((m.overrides ?? []).map((o) => [o.name, o.default])),
    fns: {},
    bindings: {},
    structs: new Map(m.structs.map((s) => [s.name, s])),
    gpuStubs: opts?.gpuStubs ?? false,
  }
  // Populate consts in declaration order so a later const may reference an
  // earlier one. A `valueExpr` const (vec / array / struct literal) is evaluated
  // through the same tree-walk; a scalar const uses its full-precision cpuValue.
  for (const c of m.consts) {
    ctx.consts.set(c.name, c.valueExpr ? evalExpr(c.valueExpr, new Map(), ctx) : c.cpuValue)
  }
  for (const f of m.funcs) {
    ctx.fns[f.name] = (...args: CpuValue[]): CpuValue => {
      const env = new Map<string, CpuValue>()
      f.params.forEach((p, i) => env.set(p.name, args[i]))
      const r = execBody(f.body, env, ctx)
      // Unread placeholder: a void (ret: voidT) fn is invoked as a STATEMENT — its value
      // is never consumed, so the undefined bridged to CpuValue here is never read.
      return r.kind === 'return' ? (r.value as CpuValue) : (undefined as unknown as CpuValue)
    }
  }
  return {
    fns: ctx.fns,
    setBinding: (name, value) => {
      ctx.bindings[name] = value
    },
  }
}
