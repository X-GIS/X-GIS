// ═══ Shader DSL — CPU (f64) op-library ═══
//
// The SHARED value model + operation library for the two CPU backends over the
// SAME IR: the tree-walk interpreter (oracle.ts) and the js-source backend
// (cpu-codegen.ts). Keeping the builtin/GPU-stub tables + the scalar/vector/
// matrix op helpers here — one authority — is what makes the js-source backend
// BIT-IDENTICAL to the interpreter by construction: both run the IDENTICAL
// Math.* op tree in f64 (no fround), so a `new Function` twin can never drift
// from the reference tree-walk. See oracle.ts's header for the f64-ALGEBRA
// caveat (this library is blind to f32 GPU-precision loss — that is the GPU
// half of the two-oracle contract).
//
// Vectors are number[] (mutable, by reference so `p.x = …` assigns in place).
// Module-level consts use their cpuValue (full-precision Math.PI / Math.PI/180)
// so the projection math matches the f64 mirror, while the WGSL backend emits
// the truncated shader constants — the two-tolerance reality, structural.

import type { BinOp } from './ir'

export type CpuValue = number | boolean | number[] | CpuStruct
export interface CpuStruct {
  [k: string]: CpuValue
}

export const FIELD_IDX: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 }

export const isArr = Array.isArray

export function scalarBin(bop: BinOp, a: number, b: number, isI32 = false): number {
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

export function applyBin(bop: BinOp, a: CpuValue, b: CpuValue, isI32 = false): CpuValue {
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

const _bitcastView = new DataView(new ArrayBuffer(4))

export const BUILTINS: Record<string, Builtin> = {
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

// GPU-only stubs (#763 O3). textureSample needs the GPU's sampler/atlas; fwidth
// needs neighbouring fragments — neither is computable in this per-invocation
// interpreter. Evaluating one THROWS unless compileModule was given
// `{ gpuStubs: true }`: a silent [0,0,0,1] / 0 is a plausible-wrong value, the
// worst failure mode for a reference backend.
export const GPU_STUBS: Record<string, Builtin> = {
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

export function zeroOf(type: { kind: string; n?: number }): CpuValue {
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
export function matVec(m: number[], v: number[]): number[] {
  const n = v.length
  const out = new Array<number>(n).fill(0)
  for (let c = 0; c < n; c++) for (let r = 0; r < n; r++) out[r]! += m[c * n + r]! * v[c]!
  return out
}

// matNxN × matNxN (both column-major, flat n²). C[col*n+row] = Σ_k A[k*n+row]·B[col*n+k].
export function matMul(a: number[], b: number[]): number[] {
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
