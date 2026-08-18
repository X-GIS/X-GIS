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

/** The runtime value shape shared by both CPU backends (the tree-walk interpreter in
 *  `oracle.ts` and the compiled `new Function` twin in `cpu-codegen.ts`) — plain JS
 *  values, never a typed array or GPU buffer. A scalar (f32/f64/i32/u32/bool) is a
 *  plain JS `number`/`boolean`, evaluated in full f64 precision with no `fround` (see
 *  this file's header for the f64-algebra caveat that follows from that). A
 *  vec/vec64/mat is a flat `number[]`, mutable and shared BY REFERENCE — a `p.x = …`
 *  field write mutates the caller's array in place, which is what makes the IR's
 *  assignable lvalues (member/index writes) work without a separate store step. A
 *  struct is a `CpuStruct`. This is the one value type `CpuModule.setBinding` accepts.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export type CpuValue = number | boolean | number[] | CpuStruct
/** A struct value at CPU-eval time: a plain field-keyed object, built either by the
 *  `construct` IR node (`MyStruct(a, b, …)` → fields in declaration order) or
 *  field-by-field through a struct-typed `var` (zero-initialised by `zeroOf`, then
 *  written via `assign(out.f, …)`). Not branded to any particular struct — the field
 *  set is whatever the authoring struct declared, checked structurally by the caller.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
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

// ── f32 ↔ IEEE-754 binary16 (the pack2x16float/unpack2x16float per-component
// conversion). Hand-rolled: Math.f16round/Float16Array are too new to rely on
// across the runtimes this package supports. Encode is round-to-nearest-EVEN on
// the 13 dropped significand bits (the conversion real GPUs implement); decode
// is exact (every binary16 value is exactly representable in f32/f64). ──
const f32ToF16Bits = (x: number): number => {
  _bitcastView.setFloat32(0, Math.fround(x), true)
  const bits = _bitcastView.getUint32(0, true)
  const sign = (bits >>> 16) & 0x8000
  const exp = (bits >>> 23) & 0xff
  const mant = bits & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant !== 0 ? 0x200 : 0) // ±Inf / NaN (quieted)
  const e = exp - 127 + 15 // re-bias 127 → 15
  if (e >= 0x1f) return sign | 0x7c00 // overflow → ±Inf
  if (e <= 0) {
    // Too small for a normal f16 → subnormal (or ±0 below 2^-25).
    if (e < -10) return sign
    const m = mant | 0x800000 // implicit leading 1
    const shift = 14 - e // 14..24 — how many low bits fall off
    const half = m >>> shift
    const rem = m & ((1 << shift) - 1)
    const halfway = 1 << (shift - 1)
    if (rem > halfway || (rem === halfway && (half & 1) !== 0)) return sign | (half + 1)
    return sign | half
  }
  const half = sign | (e << 10) | (mant >>> 13)
  const rem = mant & 0x1fff
  // RTE carry may roll the significand into the exponent (…1111.1→10000.0) and,
  // at the top, into ±Inf — both are the correctly-rounded results.
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1) !== 0)) return half + 1
  return half
}
const f16BitsToF32 = (h: number): number => {
  const sign = (h & 0x8000) << 16
  const exp = (h >>> 10) & 0x1f
  const mant = h & 0x3ff
  let bits: number
  if (exp === 0) {
    if (mant === 0)
      bits = sign // ±0
    else {
      // Subnormal: normalise the significand into f32's implicit-1 form.
      let e = 0
      let m = mant
      while ((m & 0x400) === 0) {
        m <<= 1
        e++
      }
      bits = sign | ((127 - 15 - e + 1) << 23) | ((m & 0x3ff) << 13)
    }
  } else if (exp === 0x1f) {
    bits = sign | 0x7f800000 | (mant << 13) // ±Inf / NaN
  } else {
    bits = sign | ((exp - 15 + 127) << 23) | (mant << 13)
  }
  _bitcastView.setUint32(0, bits >>> 0, true)
  return _bitcastView.getFloat32(0, true)
}

export const BUILTINS: Record<string, Builtin> = {
  sin: map1(Math.sin),
  cos: map1(Math.cos),
  tan: map1(Math.tan),
  asin: map1(Math.asin),
  acos: map1(Math.acos),
  atan: map1(Math.atan),
  // Hyperbolics — native on BOTH targets (WGSL §17.5 / GLSL ES 3.00 §8.1), and
  // the exact spelling of the Mercator idioms: forward y = asinh(tan φ)
  // ≡ log(tan(π/4 + φ/2)), inverse φ = atan(sinh y) ≡ 2·atan(exp y) − π/2.
  sinh: map1(Math.sinh),
  cosh: map1(Math.cosh),
  tanh: map1(Math.tanh),
  asinh: map1(Math.asinh),
  acosh: map1(Math.acosh),
  atanh: map1(Math.atanh),
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
  // atan2(y, x) — component-wise over vectors (as WGSL/GLSL compute it); x may
  // be a scalar broadcast (the ArithArg surface admits it even though WGSL then
  // rejects the emit — the oracle mirrors the component-wise semantics).
  atan2: (y, x) =>
    isArr(y)
      ? (y as number[]).map((v, i) =>
          Math.atan2(v as number, isArr(x) ? ((x as number[])[i] as number) : (x as number)),
        )
      : Math.atan2(y as number, x as number),
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
  // saturate(x) = clamp(x, 0, 1) — WGSL's dedicated builtin (GLSL inlines the
  // clamp; see the intrinsic registry). Same max(0, min(1, ·)) ordering as clamp.
  saturate: map1((x) => Math.max(0, Math.min(1, x))),
  mix: (a, b, t) => mixVal(a, b, t),
  // smoothstep — component-wise; the vector overload (#763 X15) makes the vec
  // path reachable, and the old scalar-cast body silently returned NaN for it
  // (JS array arithmetic). e0/e1 may be scalar broadcasts over a vector x.
  smoothstep: (e0, e1, x) => {
    const ss = (a: number, b: number, v: number): number => {
      const t = Math.max(0, Math.min(1, (v - a) / (b - a)))
      return t * t * (3 - 2 * t)
    }
    return isArr(x)
      ? (x as number[]).map((v, i) =>
          ss(
            isArr(e0) ? ((e0 as number[])[i] as number) : (e0 as number),
            isArr(e1) ? ((e1 as number[])[i] as number) : (e1 as number),
            v as number,
          ),
        )
      : ss(e0 as number, e1 as number, x as number)
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
  // tail of the f64 add — beyond every tolerance the suites assert.
  // Component-wise over vectors (WGSL fma is genType, and the authoring
  // signature admits vec keys) — the old scalar-cast body silently NaN'd there.
  fma: (a, b, c) => {
    const f = (x: number, y: number, z: number): number => Math.fround(x * y + z)
    const at = (v: CpuValue, i: number): number => (isArr(v) ? (v[i] as number) : (v as number))
    return isArr(a)
      ? (a as number[]).map((x, i) => f(x as number, at(b, i), at(c, i)))
      : f(a as number, b as number, c as number)
  },
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
  // ── 2×16 pack/unpack — native builtins on BOTH targets (only the names
  // diverge; see the intrinsic registry). Component 0 → the 16 LOW bits, per
  // both specs. Quantisation follows WGSL's ⌊0.5 + scale·clamp(e)⌋, which JS
  // Math.round IS (floor(0.5+x), including the toward-+∞ negative halves). ──
  pack2x16float: (v) => {
    const a = v as number[]
    return (f32ToF16Bits(a[0] as number) | (f32ToF16Bits(a[1] as number) << 16)) >>> 0
  },
  unpack2x16float: (u) => {
    const n = (u as number) >>> 0
    return [f16BitsToF32(n & 0xffff), f16BitsToF32(n >>> 16)]
  },
  pack2x16unorm: (v) => {
    const a = v as number[]
    const q = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * 65535) & 0xffff
    return (q(a[0] as number) | (q(a[1] as number) << 16)) >>> 0
  },
  unpack2x16unorm: (u) => {
    const n = (u as number) >>> 0
    return [(n & 0xffff) / 65535, (n >>> 16) / 65535]
  },
  pack2x16snorm: (v) => {
    const a = v as number[]
    const q = (x: number): number => Math.round(Math.max(-1, Math.min(1, x)) * 32767) & 0xffff
    return (q(a[0] as number) | (q(a[1] as number) << 16)) >>> 0
  },
  unpack2x16snorm: (u) => {
    const n = (u as number) >>> 0
    // Sign-extend each 16-bit lane, then v/32767 clamped at −1 (WGSL: max(v/32767, −1);
    // GLSL's clamp(…, −1, 1) is identical — v ≤ 32767 so the upper clamp never binds).
    const s = (bits: number): number => Math.max(((bits << 16) >> 16) / 32767, -1)
    return [s(n & 0xffff), s(n >>> 16)]
  },
}

// GPU-only stubs (#763 O3). textureSample needs the GPU's sampler/atlas; fwidth
// needs neighbouring fragments — neither is computable in this per-invocation
// interpreter. Evaluating one THROWS unless compileModule was given
// `{ gpuStubs: true }`: a silent [0,0,0,1] / 0 is a plausible-wrong value, the
// worst failure mode for a reference backend.
export const GPU_STUBS: Record<string, Builtin> = {
  textureSample: () => [0, 0, 0, 1],
  textureSampleLevel: () => [0, 0, 0, 1],
  fwidth: () => 0,
  dpdx: () => 0,
  dpdy: () => 0,
  textureLoad: () => [0, 0, 0, 1],
  // 2d-array reads (#1651) — same placeholder/throw contract as their 2d twins:
  // the oracle has no texture memory, so under `gpuStubs` they yield opaque black.
  textureSampleArray: () => [0, 0, 0, 1],
  textureSampleLevelArray: () => [0, 0, 0, 1],
  textureLoadArray: () => [0, 0, 0, 1],
  textureDimensions: () => [1, 1], // 1×1, not 0×0 — a divide-by-dimensions stays finite
  textureNumLayers: () => 1, // 1 layer, not 0 — a modulo/divide by the count stays finite
}

/** Test-only surfaces (#763 O5): the oracle's builtin coverage, pinned against the
 *  intrinsic catalogue so a new portable intrinsic cannot ship without a CPU twin. */
export const ORACLE_BUILTIN_NAMES: ReadonlySet<string> = new Set(Object.keys(BUILTINS))
/** The names of every GPU-only intrinsic the oracle cannot genuinely evaluate — the
 *  keys of `GPU_STUBS` (textureSample / textureSampleLevel / fwidth / dpdx / dpdy /
 *  textureLoad and their 2d-array twins, plus textureDimensions / textureNumLayers),
 *  not the placeholder implementations themselves. Calling one of these from a
 *  compiled module THROWS unless it was compiled with `{ gpuStubs: true }`, in which
 *  case it returns an opaque placeholder (`[0,0,0,1]` for a texture read, `0` for a
 *  derivative) instead of a value the interpreter has any way to compute — a
 *  reference backend fails loud by default rather than hand back a plausible-wrong
 *  number. Exists so a test can union this set with `ORACLE_BUILTIN_NAMES` against
 *  the full intrinsic catalogue and assert every WGSL/GLSL-emittable intrinsic has
 *  either a real CPU implementation or a documented stub here — the check that stops
 *  a new "portable" intrinsic from shipping with no CPU twin and throwing
 *  `unknown fn` at first CPU use.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
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
