// ═══ Shader DSL — df64 (double-float) emulation library ═══
//
// The two-f32 emulated-double arithmetic the fp64-lower pass (passes/
// fp64-lower.ts) rewrites f64-typed IR into. An f64 value is an unevaluated
// (hi, lo) pair carried as a vec2<f32> — x = hi, y = lo, |lo| ≤ ulp(hi)/2 —
// giving ~48 significand bits at f32 exponent range.
//
// Lineage: DSFUN90 (D. H. Bailey) → the NVIDIA CUDA SDK Mandelbrot sample's
// dsadd/dsmul → Thall, "Extended-Precision Floating-Point Numbers for GPU
// Computation" (twoSum / quickTwoSum / Veltkamp split / twoProd) → luma.gl's
// fp64 GLSL module, whose GUARDED formulation these bodies mirror.
//
// ── The ONE guard (why every body threads a runtime-opaque `one`) ──
// The error-free transformations below are algebraically trivial (e.g.
// `e = b - (s - a)` is 0 in real arithmetic). WGSL §15.7.5 explicitly PERMITS
// reassociation/fusion, Metal defaults to fast-math, and ANGLE's D3D compiler
// reassociates — any of which folds the error terms away and silently
// collapses df64 to f32 precision. Neither WGSL nor GLSL ES 3.00 has a
// `precise` qualifier. The portable defense (luma.gl's
// LUMA_FP64_CODE_ELIMINATION_WORKAROUND lineage) is a runtime-opaque ONE
// (value 1.0) multiplied through the EFT intermediates, so no compiler can
// cancel them at compile time. The value is fetched from a 1×1 TEXTURE (the
// `f64Guard` intrinsic → textureLoad/texelFetch on the injected `_fp64`
// binding), NOT a uniform: uniforms are defeated by drivers that SPECIALIZE
// pipelines on observed uniform values and hot-swap background-reoptimized
// variants (seen in the field on Windows/NVIDIA — the f64 half alternated
// with an f32-collapsed rendering mid-session); no driver constant-folds
// texel values. The binding is AUTO-INJECTED by fp64Lower into any module
// that uses these helpers (pin its slot with `fp64Guard()` when an engine's
// bind-group layout demands it); the host MUST bind a 1×1 texture whose texel
// reads back exactly 1.0 (e.g. RGBA8 255 or R32F 1.0).
// FMA-based twoProd is deliberately NOT used — WGSL fma()'s accuracy is
// "inherited from x*y+z" (fusion not guaranteed).
//
// These fns are injected into a module by fp64-lower (never listed by
// authors); the `df64_` name prefix is reserved (SD0043). Their bodies are
// ordinary IR, but the emit optimizer must keep the calls OPAQUE — see the
// `df64_` skip in passes/auto-inline.ts.

import {
  fn,
  Let,
  Var,
  vec2,
  sqrt,
  floor,
  abs,
  member,
  construct,
  structT,
  f32T,
  vec2fT,
  vec3fT,
  vec4fT,
  texture2dfT,
  f64GuardOne,
  type Node,
  type ReadonlyNode,
  type StructDecl,
  type BindingDecl,
  type FuncDecl,
  type ShaderType,
} from '../ir'

// ── Host-side split (the packing twin of the shader emulation) ──

/** Split a JS double into its (hi, lo) f32 pair — the value a df64 uniform /
 *  attribute / literal carries on the GPU. hi = f32(x), lo = f32(x − hi);
 *  hi + lo reconstructs x to ~48 significand bits. Same convention as the
 *  tiler's ECEF DSFUN packing (compiler/src/tiler/ecef-packing.ts). */
export function splitF64(x: number): [hi: number, lo: number] {
  const hi = Math.fround(x)
  const lo = Math.fround(x - hi)
  return [hi, lo]
}

// ── The anti-fast-math guard texture ──

export const FP64_GUARD_NAME = '_fp64'
/** The guard binding's type: a 1×1 2D texture whose only texel reads 1.0. */
export const FP64_GUARD_TYPE: ShaderType = texture2dfT

export interface Fp64GuardHandle {
  readonly type: ShaderType
  readonly binding: BindingDecl
}

/** OPTIONAL pin for the fp64 guard texture's slot. A module that uses f64
 *  arithmetic gets a `texture_2d<f32>` binding named `_fp64` AUTO-INJECTED by
 *  fp64Lower (deterministically at group 0, first free binding) — authors
 *  declare NOTHING for the default. Use this declarator in
 *  `module({ uses: [...] })` only to pin the (group, binding) to an engine's
 *  fixed bind-group layout. Either way the binding shows up in reflect() as an
 *  ordinary 2D texture, and the host MUST bind a 1×1 texture whose texel
 *  reads back exactly 1.0 (RGBA8 white / R32F 1.0) — the value is
 *  semantically 1.0; it lives in a texture only so downstream shader
 *  compilers can never treat it as a compile-time constant (see the file
 *  header). */
export function fp64Guard(at: { group: number; binding: number }): Fp64GuardHandle {
  return {
    type: FP64_GUARD_TYPE,
    binding: {
      group: at.group,
      binding: at.binding,
      name: FP64_GUARD_NAME,
      space: 'uniform',
      type: FP64_GUARD_TYPE,
    },
  }
}

/** The runtime-opaque 1.0 every helper body threads through its EFT terms —
 *  the `f64Guard` intrinsic (a texel fetch on the GPU, exactly 1 on the CPU
 *  oracle). One shared node; the emit CSE hoists a single fetch per body. */
const one = f64GuardOne() as ReadonlyNode<'f32'>

// ── Error-free transformation primitives ──

/** Knuth two-sum: s + e == a + b exactly, no magnitude precondition. */
const df64_twoSum = fn('df64_twoSum', { a: f32T, b: f32T }, (p) => {
  const s = Let(p.a.add(p.b))
  const v = Let(s.mul(one).sub(p.a).mul(one))
  const e = Let(p.a.sub(s.sub(v).mul(one)).mul(one).mul(one).mul(one).add(p.b.sub(v)))
  return vec2(s, e)
})

/** Dekker fast-two-sum: requires |a| ≥ |b| (renormalization step). */
const df64_quickTwoSum = fn('df64_quickTwoSum', { a: f32T, b: f32T }, (p) => {
  const s = Let(p.a.add(p.b).mul(one))
  const e = Let(p.b.sub(s.sub(p.a).mul(one)))
  return vec2(s, e)
})

/** Veltkamp split by 4097 = 2¹² + 1: a == hi + lo with 12-bit hi, 11-bit lo.
 *  The split constant reaches the shader as `4097 * one` so it can never be
 *  folded. Overflows for |a| > ~2¹¹⁵ (out of geographic range). */
const df64_split = fn('df64_split', { a: f32T }, (p) => {
  const t = Let(p.a.mul(one.mul(4097.0)))
  const hi = Let(t.mul(one).sub(t.sub(p.a)))
  const lo = Let(p.a.mul(one).sub(hi))
  return vec2(hi, lo)
})

/** Split-based two-product: p + e == a * b exactly. (Not FMA-based — see header.) */
const df64_twoProd = fn('df64_twoProd', { a: f32T, b: f32T }, (p) => {
  const prod = Let(p.a.mul(p.b))
  const aS = Let(df64_split({ a: p.a }))
  const bS = Let(df64_split({ a: p.b }))
  const e = Let(
    aS.x.mul(bS.x).sub(prod).add(aS.x.mul(bS.y)).add(aS.y.mul(bS.x)).add(aS.y.mul(bS.y)),
  )
  return vec2(prod, e)
})

/** Two-square: p + e == a * a exactly (the twoProd special case sqrt uses). */
const df64_twoSqr = fn('df64_twoSqr', { a: f32T }, (p) => {
  const prod = Let(p.a.mul(p.a))
  const aS = Let(df64_split({ a: p.a }))
  const e = Let(
    aS.x
      .mul(aS.x)
      .sub(prod)
      .mul(one)
      .add(aS.x.mul(aS.y).mul(2.0).mul(one).mul(one))
      .add(aS.y.mul(aS.y).mul(one).mul(one).mul(one)),
  )
  return vec2(prod, e)
})

// ── df64 arithmetic ──

/** a + b (Thall/QD-style accurate add: two twoSums + double renormalization). */
const df64_add = fn('df64_add', { a: vec2fT, b: vec2fT }, (p) => {
  const s = Var(df64_twoSum({ a: p.a.x, b: p.b.x }))
  const t = Let(df64_twoSum({ a: p.a.y, b: p.b.y }))
  s.y.assign(s.y.add(t.x))
  s.assign(df64_quickTwoSum({ a: s.x, b: s.y }))
  s.y.assign(s.y.add(t.y))
  s.assign(df64_quickTwoSum({ a: s.x, b: s.y }))
  return s
})

/** a − b == a + (−b); componentwise negation of a df64 pair is exact. */
const df64_sub = fn('df64_sub', { a: vec2fT, b: vec2fT }, (p) => df64_add({ a: p.a, b: p.b.neg() }))

/** a × b: twoProd of the hi words + cross terms + renormalize.
 *  Renormalizes (df64_quickTwoSum, which carries the `one` guard) AFTER EACH
 *  cross term — not once at the end as textbook QD does. The intermediate
 *  renorm is the luma.gl / donmccurdy Apple defense: it folds each cross term
 *  into a fresh (hi, lo) pair through a guarded twoSum before the next product,
 *  so a driver's fast-math cannot keep a·b_hi + a·b_lo as one sum and factor
 *  the common a out (which rounds b_hi+b_lo back to b_hi and deletes the cross
 *  term — Apple Metal "optimizes away the calculation necessary for emulated
 *  fp64"). Merely threading `one` through the cross terms does NOT help: the
 *  common factor sits outside the guard. */
const df64_mul = fn('df64_mul', { a: vec2fT, b: vec2fT }, (p) => {
  const prod = Var(df64_twoProd({ a: p.a.x, b: p.b.x }))
  prod.y.assign(prod.y.add(p.a.x.mul(p.b.y)))
  prod.assign(df64_quickTwoSum({ a: prod.x, b: prod.y }))
  prod.y.assign(prod.y.add(p.a.y.mul(p.b.x)))
  return df64_quickTwoSum({ a: prod.x, b: prod.y })
})

/** a ÷ b: f32-reciprocal seed + one Newton-Raphson correction (luma.gl form). */
const df64_div = fn('df64_div', { a: vec2fT, b: vec2fT }, (p) => {
  const xn = Let(one.div(p.b.x))
  const yn = Let(p.a.mul(xn))
  const diff = Let(df64_sub({ a: p.a, b: df64_mul({ a: p.b, b: yn }) }).x)
  const prod = Let(df64_twoProd({ a: xn, b: diff }))
  return df64_add({ a: yn, b: prod })
})

/** √a: f32 rsqrt seed + one Newton-Raphson correction; √0 = 0 exactly.
 *  a < 0 is a domain error (NaN/indeterminate, as with native sqrt). */
const df64_sqrt = fn(
  'df64_sqrt',
  { a: vec2fT },
  (p) => {
    const x = Let(one.div(sqrt(p.a.x)))
    const yn = Let(p.a.x.mul(x))
    const ynSqr = Let(df64_twoSqr({ a: yn }).mul(one))
    const diff = Let(df64_sub({ a: p.a, b: ynSqr }).x)
    const prod = Let(df64_twoProd({ a: x.mul(0.5), b: diff }))
    const res = Let(df64_add({ a: vec2(yn, 0.0), b: prod }))
    return p.a.x.eq(0.0).select(vec2(0.0, 0.0), res)
  },
  { lintDisable: ['no-float-eq'] }, // exact ==0 zero-guard, not a tolerance bug
)

// ── Comparisons (lexicographic: hi decides, lo breaks ties) ──
// The float `==` on the hi/lo words is EXACT pair comparison, not an epsilon
// bug — hence the documented no-float-eq deviations.

const df64_lt = fn(
  'df64_lt',
  { a: vec2fT, b: vec2fT },
  (p) => p.a.x.lt(p.b.x).or(p.a.x.eq(p.b.x).and(p.a.y.lt(p.b.y))),
  { lintDisable: ['no-float-eq'] },
)
const df64_gt = fn(
  'df64_gt',
  { a: vec2fT, b: vec2fT },
  (p) => p.a.x.gt(p.b.x).or(p.a.x.eq(p.b.x).and(p.a.y.gt(p.b.y))),
  { lintDisable: ['no-float-eq'] },
)
const df64_le = fn(
  'df64_le',
  { a: vec2fT, b: vec2fT },
  (p) => p.a.x.lt(p.b.x).or(p.a.x.eq(p.b.x).and(p.a.y.le(p.b.y))),
  { lintDisable: ['no-float-eq'] },
)
const df64_ge = fn(
  'df64_ge',
  { a: vec2fT, b: vec2fT },
  (p) => p.a.x.gt(p.b.x).or(p.a.x.eq(p.b.x).and(p.a.y.ge(p.b.y))),
  { lintDisable: ['no-float-eq'] },
)
const df64_eq = fn(
  'df64_eq',
  { a: vec2fT, b: vec2fT },
  (p) => p.a.x.eq(p.b.x).and(p.a.y.eq(p.b.y)),
  { lintDisable: ['no-float-eq'] },
)
const df64_ne = fn(
  'df64_ne',
  { a: vec2fT, b: vec2fT },
  (p) => p.a.x.ne(p.b.x).or(p.a.y.ne(p.b.y)),
  { lintDisable: ['no-float-eq'] },
)

// ── Componentwise / selection builtins ──

/** |a| — sign decided by hi (a normalized pair with hi = 0 has lo = 0). */
const df64_abs = fn('df64_abs', { a: vec2fT }, (p) => p.a.x.lt(0.0).select(p.a.neg(), p.a))

const df64_min = fn('df64_min', { a: vec2fT, b: vec2fT }, (p) =>
  df64_lt({ a: p.a, b: p.b }).select(p.a, p.b),
)
const df64_max = fn('df64_max', { a: vec2fT, b: vec2fT }, (p) =>
  df64_gt({ a: p.a, b: p.b }).select(p.a, p.b),
)

/** mix(a, b, t) == a + (b − a)·t; the interpolant t stays f32 (widened exactly). */
const df64_mix = fn('df64_mix', { a: vec2fT, b: vec2fT, t: f32T }, (p) =>
  df64_add({ a: p.a, b: df64_mul({ a: df64_sub({ a: p.b, b: p.a }), b: vec2(p.t, 0.0) }) }),
)

/** ⌊a⌋ — floor(hi); when hi is already integral the lo word decides. */
const df64_floor = fn(
  'df64_floor',
  { a: vec2fT },
  (p) => {
    const fhi = Let(floor(p.a.x))
    return fhi.eq(p.a.x).select(df64_quickTwoSum({ a: fhi, b: floor(p.a.y) }), vec2(fhi, 0.0))
  },
  { lintDisable: ['no-float-eq'] }, // exact integrality test, not a tolerance bug
)

/** fract(a) == a − ⌊a⌋. */
const df64_fract = fn('df64_fract', { a: vec2fT }, (p) =>
  df64_sub({ a: p.a, b: df64_floor({ a: p.a }) }),
)

// ── Conversions ──

/** The EXPLICIT precision-losing narrow: f64 → f32 as hi + lo. (The widen
 *  f32 → f64 needs no helper — fp64-lower emits `vec2<f32>(x, 0.0)`.) */
const df64_narrow = fn('df64_narrow', { a: vec2fT }, (p) => p.a.x.add(p.a.y))

// ── Transcendentals (sin / cos) — luma.gl fp64 port ──
//
// A 3-stage argument reduction (mod 2π → quadrant j·π/2 → index k·π/16) leaves a
// residual |t| ≤ π/32 on which a short Taylor series is well-conditioned; a tabled
// angle-addition (u = cos(kπ/16), v = sin(kπ/16)) plus the quadrant j swap/sign
// reconstruct the full-range result. Every arithmetic step runs through the df64_*
// helpers above (which thread the `one` guard) — the two reduction picks are the
// only PLAIN-f32 arithmetic (`floor(x/step + 0.5)` selects a small integer, not a
// df64 value, exactly as luma.gl authors them). Accuracy is the port's: the Taylor
// truncation floors relative error at ~2^-36 for the transcendental itself, then it
// degrades with argument magnitude through the reduction (the inherent large-arg
// precision loss). Built on df64_mul, so — like df64_mul — correct only where the
// multiply survives fast-math; Apple/Metal collapses it (see the df64_mul note and
// AUTHORING §7). NOT a native builtin: the f32 `sin`/`cos` of a large angle are
// noise (the f32 argument itself has lost the sub-ulp phase) — that is the gate.

/** The df64 sin/cos constant VALUES (JS doubles). Each reaches the shader as a
 *  vec2<f32>(hi, lo) via splitF64 (hi = fround(v), lo = the fround residual);
 *  exported so df64-sincos.test.ts can pin that hi+lo round-trips v to df64
 *  precision (a mis-split — the luma.gl hand-typed-pair failure mode — trips it). */
export const DF64_TRIG_CONSTANTS = {
  TWO_PI: 2 * Math.PI,
  PI_2: Math.PI / 2,
  PI_16: Math.PI / 16,
  INV_FACT_3: 1 / 6,
  INV_FACT_4: 1 / 24,
  INV_FACT_5: 1 / 120,
  INV_FACT_6: 1 / 720,
  // cos / sin of k·π/16 for k = 1..4 — the angle-addition tables, indexed |k|−1.
  COS_TABLE: [1, 2, 3, 4].map((k) => Math.cos((k * Math.PI) / 16)),
  SIN_TABLE: [1, 2, 3, 4].map((k) => Math.sin((k * Math.PI) / 16)),
} as const

/** A df64 constant literal pair vec2<f32>(hi, lo). A plain INPUT — no `one` guard
 *  (the guard protects the EFT arithmetic these feed, never the literals). */
const dfLit = (x: number): ReadonlyNode<'vec2<f32>'> =>
  vec2(...splitF64(x)) as ReadonlyNode<'vec2<f32>'>

const TWO_PI = dfLit(DF64_TRIG_CONSTANTS.TWO_PI)
const PI_2 = dfLit(DF64_TRIG_CONSTANTS.PI_2)
const PI_16 = dfLit(DF64_TRIG_CONSTANTS.PI_16)
const INV_FACT_3 = dfLit(DF64_TRIG_CONSTANTS.INV_FACT_3)
const INV_FACT_4 = dfLit(DF64_TRIG_CONSTANTS.INV_FACT_4)
const INV_FACT_5 = dfLit(DF64_TRIG_CONSTANTS.INV_FACT_5)
const INV_FACT_6 = dfLit(DF64_TRIG_CONSTANTS.INV_FACT_6)
const COS_TABLE = DF64_TRIG_CONSTANTS.COS_TABLE.map(dfLit)
const SIN_TABLE = DF64_TRIG_CONSTANTS.SIN_TABLE.map(dfLit)
// The hi words of the two reduction steps — the plain-f32 quadrant/index picks
// divide by these (matching luma.gl's `r.x / PI_2.x`, hi-word only).
const PI_2_HI = Math.fround(DF64_TRIG_CONSTANTS.PI_2)
const PI_16_HI = Math.fround(DF64_TRIG_CONSTANTS.PI_16)

/** round-to-nearest-integer of an f32 — luma.gl's `nint`: `floor(x + 0.5)` (ties
 *  toward +∞, NOT away from zero). df64_nint's lo-word tie correction below is
 *  ported to THIS convention: the two disagree by 1 at a negative half-integer, so
 *  rounding ties away from zero here would double-count the correction and offset
 *  the mod-2π turn count z by 1 (r off by 2π → wrong quadrant → sign/swap inverted). */
const nintF32 = (x: ReadonlyNode<'f32'>): ReadonlyNode<'f32'> => floor(x.add(0.5))

/** Round a df64 to the nearest integer (as a df64) — the mod-2π reduction's turn
 *  count. When hi is already integral the lo word decides (round it too, then
 *  renormalize); otherwise round hi, using the lo word to break the x.5 tie. */
const df64_nint = fn(
  'df64_nint',
  { a: vec2fT },
  (p) => {
    const hi = Let(nintF32(p.a.x))
    const loArm = df64_quickTwoSum({ a: hi, b: nintF32(p.a.y) })
    const tie = Let(abs(hi.sub(p.a.x)).eq(0.5).and(p.a.y.lt(0.0)).select(hi.sub(1.0), hi))
    return hi.eq(p.a.x).select(loArm, vec2(tie, 0.0))
  },
  { lintDisable: ['no-float-eq'] }, // exact integrality / x.5-tie tests
)

/** sin(a) for |a| ≤ π/32 — Taylor a − a³/6 + a⁵/120 with x = −a² (r accumulates
 *  the odd powers, s the partial sum). Well-conditioned on the tiny residual. */
const df64_sin_taylor = fn('df64_sin_taylor', { a: vec2fT }, (p) => {
  const x = Let(df64_mul({ a: p.a, b: p.a }).neg())
  const r1 = Let(df64_mul({ a: p.a, b: x }))
  const s1 = Let(df64_add({ a: p.a, b: df64_mul({ a: r1, b: INV_FACT_3 }) }))
  const r2 = Let(df64_mul({ a: r1, b: x }))
  return df64_add({ a: s1, b: df64_mul({ a: r2, b: INV_FACT_5 }) })
})

/** cos(a) for |a| ≤ π/32 — Taylor 1 − a²/2 + a⁴/24 − a⁶/720 with x = −a². */
const df64_cos_taylor = fn('df64_cos_taylor', { a: vec2fT }, (p) => {
  const x = Let(df64_mul({ a: p.a, b: p.a }).neg())
  const s0 = Let(df64_add({ a: dfLit(1), b: df64_mul({ a: x, b: dfLit(0.5) }) }))
  const r1 = Let(df64_mul({ a: x, b: x }))
  const s1 = Let(df64_add({ a: s0, b: df64_mul({ a: r1, b: INV_FACT_4 }) }))
  const r2 = Let(df64_mul({ a: r1, b: x }))
  return df64_add({ a: s1, b: df64_mul({ a: r2, b: INV_FACT_6 }) })
})

/** |k|-indexed angle-addition table pick (kk ∈ {0..4}); kk = 0 falls through to
 *  `zero` (cos 0 = 1 / sin 0 = 0), so the caller needs no k = 0 special case. */
const pickByAbsK = (
  kk: ReadonlyNode<'f32'>,
  table: readonly ReadonlyNode<'vec2<f32>'>[],
  zero: ReadonlyNode<'vec2<f32>'>,
): ReadonlyNode<'vec2<f32>'> =>
  kk
    .eq(1.0)
    .select(
      table[0]!,
      kk
        .eq(2.0)
        .select(table[1]!, kk.eq(3.0).select(table[2]!, kk.eq(4.0).select(table[3]!, zero))),
    )

/** The shared 3-stage reduction + tabled angle-addition. Returns the quadrant j
 *  (as an integer-valued f32) and (sin φ, cos φ) for φ = k·π/16 + t; df64_sin /
 *  df64_cos apply the j swap/sign. Emitted inline in BOTH (luma.gl authors
 *  sin_fp64 / cos_fp64 each with its own reduction) — the DRY lives in this TS
 *  builder, not a shared fn: a helper would need the multi-value return this IR
 *  has no scalar shape for. Called only inside the df64_sin / df64_cos bodies. */
const reduceSinCos = (
  a: ReadonlyNode<'vec2<f32>'>,
): {
  qj: ReadonlyNode<'f32'>
  sinPhi: ReadonlyNode<'vec2<f32>'>
  cosPhi: ReadonlyNode<'vec2<f32>'>
} => {
  // 1) mod 2π: r = a − 2π·nint(a/2π) ∈ [−π, π].
  const z = Let(df64_nint({ a: df64_div({ a, b: TWO_PI }) }))
  const r = Let(df64_sub({ a, b: df64_mul({ a: TWO_PI, b: z }) }))
  // 2) quadrant j ∈ [−2, 2]: t = r − (π/2)·j, |t| ≤ π/4.
  const qj = Let(floor(r.x.div(PI_2_HI).add(0.5)))
  const t1 = Let(df64_sub({ a: r, b: df64_mul({ a: PI_2, b: vec2(qj, 0.0) }) }))
  // 3) index k ∈ [−4, 4]: t = t − (π/16)·k, |t| ≤ π/32.
  const qk = Let(floor(t1.x.div(PI_16_HI).add(0.5)))
  const t = Let(df64_sub({ a: t1, b: df64_mul({ a: PI_16, b: vec2(qk, 0.0) }) }))
  const sinT = Let(df64_sin_taylor({ a: t }))
  const cosT = Let(df64_cos_taylor({ a: t }))
  // angle addition: sinφ = u·sinT + sgn(k)·v·cosT, cosφ = u·cosT − sgn(k)·v·sinT.
  const kk = Let(abs(qk))
  const u = Let(pickByAbsK(kk, COS_TABLE, dfLit(1)))
  const vAbs = Let(pickByAbsK(kk, SIN_TABLE, dfLit(0)))
  const v = Let(qk.ge(0.0).select(vAbs, vAbs.neg()))
  const sinPhi = Let(df64_add({ a: df64_mul({ a: u, b: sinT }), b: df64_mul({ a: v, b: cosT }) }))
  const cosPhi = Let(df64_sub({ a: df64_mul({ a: u, b: cosT }), b: df64_mul({ a: v, b: sinT }) }))
  return { qj, sinPhi, cosPhi }
}

/** sin(a), full range — 3-stage reduction + Taylor, then the quadrant j swap:
 *  j = 0 → sinφ, +1 → cosφ, −1 → −cosφ, ±2 → −sinφ. */
const df64_sin = fn(
  'df64_sin',
  { a: vec2fT },
  (p) => {
    const { qj, sinPhi, cosPhi } = reduceSinCos(p.a)
    return qj
      .eq(0.0)
      .select(sinPhi, qj.eq(1.0).select(cosPhi, qj.eq(-1.0).select(cosPhi.neg(), sinPhi.neg())))
  },
  { lintDisable: ['no-float-eq'] }, // exact integer-quadrant tests
)

/** cos(a), full range — the same reduction with the cos quadrant swap:
 *  j = 0 → cosφ, +1 → −sinφ, −1 → sinφ, ±2 → −cosφ. */
const df64_cos = fn(
  'df64_cos',
  { a: vec2fT },
  (p) => {
    const { qj, sinPhi, cosPhi } = reduceSinCos(p.a)
    return qj
      .eq(0.0)
      .select(cosPhi, qj.eq(1.0).select(sinPhi.neg(), qj.eq(-1.0).select(sinPhi, cosPhi.neg())))
  },
  { lintDisable: ['no-float-eq'] },
)

// ── Vectorized df64 (vecN<f64> — the DF64VecN hi/lo-plane form) ──
//
// The EFTs are valid PER LANE, so the vector arithmetic runs the exact scalar
// formulas on whole vecN hi/lo planes (one twoSum for all lanes — no unroll).
// A vecN<f64> value lowers to `struct DF64VecN { hi: vecN<f32>, lo: vecN<f32> }`;
// these helpers take/return that struct. dot/length/distance are NOT here —
// they need cross-lane accumulation and are composed from the SCALAR df64 fns
// by the lowering pass (numerically the standard approach anyway).

const VEC_F32_T = { 2: vec2fT, 3: vec3fT, 4: vec4fT } as const

/** DF64VecN struct decls, keyed by lane count — injected by fp64-lower
 *  alongside the helpers whenever a module carries a vecN<f64>. */
export const DF64_VEC_STRUCTS: ReadonlyMap<2 | 3 | 4, StructDecl> = new Map(
  ([2, 3, 4] as const).map((n) => [
    n,
    {
      name: `DF64Vec${n}`,
      fields: [
        { name: 'hi', type: VEC_F32_T[n] },
        { name: 'lo', type: VEC_F32_T[n] },
      ],
    },
  ]),
)

function defVecHelpers(n: 2 | 3 | 4): FuncDecl[] {
  const vT: ShaderType = VEC_F32_T[n]
  const sT = structT(`DF64Vec${n}`)
  // INTERNAL type-level pinning: the bodies are width-generic (every op is
  // componentwise / a scalar broadcast), but a union-keyed node defeats the
  // method overloads — pin the phantom key to one width; the RUNTIME type is
  // always the true vT carried by the param/member exprs.
  type V = ReadonlyNode<'vec2<f32>'>
  const asV = (x: ReadonlyNode): V => x as unknown as V
  const pair = (hi: ReadonlyNode, lo: ReadonlyNode): Node => construct(sT, [hi, lo])
  const hi = (x: ReadonlyNode): V => asV(member(x, 'hi', vT))
  const lo = (x: ReadonlyNode): V => asV(member(x, 'lo', vT))

  // The scalar EFT formulas verbatim, on vecN operands (broadcast `* one`).
  const twoSum = fn(`df64_v${n}_twoSum`, { a: vT, b: vT }, (raw) => {
    const [a, b] = [asV(raw.a), asV(raw.b)]
    const s = Let(a.add(b))
    const v = Let(s.mul(one).sub(a).mul(one))
    const e = Let(a.sub(s.sub(v).mul(one)).mul(one).mul(one).mul(one).add(b.sub(v)))
    return pair(s, e)
  })
  const quickTwoSum = fn(`df64_v${n}_quickTwoSum`, { a: vT, b: vT }, (raw) => {
    const [a, b] = [asV(raw.a), asV(raw.b)]
    const s = Let(a.add(b).mul(one))
    const e = Let(b.sub(s.sub(a).mul(one)))
    return pair(s, e)
  })
  const split = fn(`df64_v${n}_split`, { a: vT }, (raw) => {
    const a = asV(raw.a)
    const t = Let(a.mul(one.mul(4097.0)))
    const h = Let(t.mul(one).sub(t.sub(a)))
    const l = Let(a.mul(one).sub(h))
    return pair(h, l)
  })
  const twoProd = fn(`df64_v${n}_twoProd`, { a: vT, b: vT }, (raw) => {
    const [a, b] = [asV(raw.a), asV(raw.b)]
    const prod = Let(a.mul(b))
    const aS = Let(split({ a }))
    const bS = Let(split({ a: b }))
    const e = Let(
      hi(aS)
        .mul(hi(bS))
        .sub(prod)
        .add(hi(aS).mul(lo(bS)))
        .add(lo(aS).mul(hi(bS)))
        .add(lo(aS).mul(lo(bS))),
    )
    return pair(prod, e)
  })
  const add = fn(`df64_v${n}_add`, { a: sT, b: sT }, (p) => {
    const s1 = Let(twoSum({ a: hi(p.a), b: hi(p.b) }))
    const t = Let(twoSum({ a: lo(p.a), b: lo(p.b) }))
    const s2 = Let(lo(s1).add(hi(t)))
    const r1 = Let(quickTwoSum({ a: hi(s1), b: s2 }))
    const s3 = Let(lo(r1).add(lo(t)))
    return quickTwoSum({ a: hi(r1), b: s3 })
  })
  const sub = fn(`df64_v${n}_sub`, { a: sT, b: sT }, (p) =>
    add({ a: p.a, b: pair(hi(p.b).neg(), lo(p.b).neg()) }),
  )
  const mul = fn(`df64_v${n}_mul`, { a: sT, b: sT }, (p) => {
    // Renormalize after each cross term (the luma.gl/donmccurdy Apple defense —
    // see the scalar df64_mul note), not once at the end.
    const p0 = Let(twoProd({ a: hi(p.a), b: hi(p.b) }))
    const r1 = Let(quickTwoSum({ a: hi(p0), b: lo(p0).add(hi(p.a).mul(lo(p.b))) }))
    return quickTwoSum({ a: hi(r1), b: lo(r1).add(lo(p.a).mul(hi(p.b))) })
  })
  const div = fn(`df64_v${n}_div`, { a: sT, b: sT }, (p) => {
    const xn = Let(one.div(hi(p.b)))
    const yn = Let(pair(hi(p.a).mul(xn), lo(p.a).mul(xn)))
    const diff = Let(hi(sub({ a: p.a, b: mul({ a: p.b, b: yn }) })))
    const prod = Let(twoProd({ a: xn, b: diff }))
    return add({ a: yn, b: prod })
  })

  // ── Componentwise builtins with PER-LANE branching ──
  // abs/min/max select a side per lane and floor's integrality test is per
  // lane, so there is no whole-plane EFT form without a per-lane select
  // (which neither WGSL-via-this-IR nor GLSL ES 3.00 gives us). Instead each
  // helper composes the VERIFIED scalar df64 fns lane by lane INSIDE its own
  // body: the struct argument is a param (evaluated once at the call), each
  // lane result is Let-bound once, and the planes gather the components.
  const LANES = 'xyzw'.slice(0, n).split('')
  type P = ReadonlyNode<'vec2<f32>'>
  const laneOf = (x: ReadonlyNode, c: string): P =>
    vec2(member(member(x, 'hi', vT), c, f32T), member(member(x, 'lo', vT), c, f32T)) as P
  const gather = (ls: readonly ReadonlyNode[]): Node =>
    pair(
      construct(
        vT,
        ls.map((l) => member(l, 'x', f32T)),
      ),
      construct(
        vT,
        ls.map((l) => member(l, 'y', f32T)),
      ),
    )

  const vAbs = fn(`df64_v${n}_abs`, { a: sT }, (p) =>
    gather(LANES.map((c) => Let(df64_abs({ a: laneOf(p.a, c) })))),
  )
  const vMin = fn(`df64_v${n}_min`, { a: sT, b: sT }, (p) =>
    gather(LANES.map((c) => Let(df64_min({ a: laneOf(p.a, c), b: laneOf(p.b, c) })))),
  )
  const vMax = fn(`df64_v${n}_max`, { a: sT, b: sT }, (p) =>
    gather(LANES.map((c) => Let(df64_max({ a: laneOf(p.a, c), b: laneOf(p.b, c) })))),
  )
  const vMix = fn(`df64_v${n}_mix`, { a: sT, b: sT, t: f32T }, (p) =>
    gather(LANES.map((c) => Let(df64_mix({ a: laneOf(p.a, c), b: laneOf(p.b, c), t: p.t })))),
  )
  const vFloor = fn(`df64_v${n}_floor`, { a: sT }, (p) =>
    gather(LANES.map((c) => Let(df64_floor({ a: laneOf(p.a, c) })))),
  )
  const vFract = fn(`df64_v${n}_fract`, { a: sT }, (p) =>
    gather(LANES.map((c) => Let(df64_fract({ a: laneOf(p.a, c) })))),
  )
  const vSin = fn(`df64_v${n}_sin`, { a: sT }, (p) =>
    gather(LANES.map((c) => Let(df64_sin({ a: laneOf(p.a, c) })))),
  )
  const vCos = fn(`df64_v${n}_cos`, { a: sT }, (p) =>
    gather(LANES.map((c) => Let(df64_cos({ a: laneOf(p.a, c) })))),
  )
  /** v / |v| — the length accumulates through the SCALAR df64 chain (the same
   *  composition the lowering uses for length()), then each lane divides by it. */
  const vNormalize = fn(`df64_v${n}_normalize`, { a: sT }, (p) => {
    const ls = LANES.map((c) => Let(laneOf(p.a, c)))
    let sq = df64_mul({ a: ls[0]!, b: ls[0]! })
    for (let i = 1; i < n; i++) sq = df64_add({ a: sq, b: df64_mul({ a: ls[i]!, b: ls[i]! }) })
    const len = Let(df64_sqrt({ a: sq }))
    return gather(ls.map((l) => Let(df64_div({ a: l, b: len }))))
  })

  return [
    twoSum.decl,
    quickTwoSum.decl,
    split.decl,
    twoProd.decl,
    add.decl,
    sub.decl,
    mul.decl,
    div.decl,
    vAbs.decl,
    vMin.decl,
    vMax.decl,
    vMix.decl,
    vFloor.decl,
    vFract.decl,
    vSin.decl,
    vCos.decl,
    vNormalize.decl,
  ]
}

// ── Matrix df64 (matNxN<f64> — the DF64MatN column-struct form) ──
//
// A matNxN<f64> lowers to `struct DF64MatN { c0..c(N-1): DF64VecN }` (columns,
// matching GPU column-major). mat·vec / matmul / transpose are the textbook
// linear-algebra compositions of the SCALAR df64 EFTs — result lane i = Σⱼ
// M[i][j] ⊗ v[j], each ⊗/⊕ a df64 twoProd/twoSum — the same extended-precision
// accumulation dot()/length() use, so no new numerics, only new shapes.

/** DF64MatN struct decls, keyed by dimension — injected by fp64-lower alongside
 *  the mat helpers (and the DF64VecN structs they nest). */
export const DF64_MAT_STRUCTS: ReadonlyMap<2 | 3 | 4, StructDecl> = new Map(
  ([2, 3, 4] as const).map((n) => [
    n,
    {
      name: `DF64Mat${n}`,
      fields: Array.from({ length: n }, (_, j) => ({
        name: `c${j}`,
        type: structT(`DF64Vec${n}`),
      })),
    },
  ]),
)

function defMatHelpers(n: 2 | 3 | 4): FuncDecl[] {
  const mT = structT(`DF64Mat${n}`)
  const vT = structT(`DF64Vec${n}`)
  const vecFT: ShaderType = VEC_F32_T[n]
  const LANES = 'xyzw'.slice(0, n).split('')
  type P = ReadonlyNode<'vec2<f32>'>
  const col = (m: ReadonlyNode, j: number): Node => member(m, `c${j}`, vT)
  // lane c of a DF64VecN → the df64 scalar (hi.c, lo.c).
  const laneOf = (v: ReadonlyNode, c: string): P =>
    vec2(member(member(v, 'hi', vecFT), c, f32T), member(member(v, 'lo', vecFT), c, f32T)) as P
  const gatherVec = (ls: readonly ReadonlyNode[]): Node =>
    construct(vT, [
      construct(
        vecFT,
        ls.map((l) => member(l, 'x', f32T)),
      ),
      construct(
        vecFT,
        ls.map((l) => member(l, 'y', f32T)),
      ),
    ])

  // M·v : result lane i = Σⱼ (column j, lane i) ⊗ v[j], accumulated in df64.
  const matVec = fn(`df64_m${n}_matvec`, { m: mT, v: vT }, (p) => {
    const cols = LANES.map((_, j) => Let(col(p.m, j)))
    const vl = LANES.map((c) => Let(laneOf(p.v, c)))
    const out = LANES.map((ci) => {
      let acc: P = df64_mul({ a: laneOf(cols[0]!, ci), b: vl[0]! })
      for (let j = 1; j < n; j++)
        acc = df64_add({ a: acc, b: df64_mul({ a: laneOf(cols[j]!, ci), b: vl[j]! }) })
      return Let(acc)
    })
    return gatherVec(out)
  })
  // A·B : each result column = A · (the matching column of B).
  const matMul = fn(`df64_m${n}_matmul`, { a: mT, b: mT }, (p) =>
    construct(
      mT,
      LANES.map((_, k) => Let(matVec({ m: p.a, v: col(p.b, k) }))),
    ),
  )
  // Mᵀ : new column i gathers lane i of every old column.
  const transpose = fn(`df64_m${n}_transpose`, { m: mT }, (p) =>
    construct(
      mT,
      LANES.map((_, i) => gatherVec(LANES.map((_, j) => Let(laneOf(col(p.m, j), LANES[i]!))))),
    ),
  )
  return [matVec.decl, matMul.decl, transpose.decl]
}

// ── Registry (the fp64-lower pass's injection SoT) ──

/** Every emulation fn, in the FIXED dependency-first order they are appended
 *  to a lowered module — primitives first, then arithmetic, then the rest —
 *  so the emitted helper section is byte-stable across modules and GLSL's
 *  define-before-use holds without forward declarations. */
export const DF64_ORDER: readonly FuncDecl[] = [
  df64_twoSum.decl,
  df64_quickTwoSum.decl,
  df64_split.decl,
  df64_twoProd.decl,
  df64_twoSqr.decl,
  df64_add.decl,
  df64_sub.decl,
  df64_mul.decl,
  df64_div.decl,
  df64_sqrt.decl,
  df64_lt.decl,
  df64_gt.decl,
  df64_le.decl,
  df64_ge.decl,
  df64_eq.decl,
  df64_ne.decl,
  df64_abs.decl,
  df64_min.decl,
  df64_max.decl,
  df64_mix.decl,
  df64_floor.decl,
  df64_fract.decl,
  df64_narrow.decl,
  df64_nint.decl,
  df64_sin_taylor.decl,
  df64_cos_taylor.decl,
  df64_sin.decl,
  df64_cos.decl,
  ...defVecHelpers(2),
  ...defVecHelpers(3),
  ...defVecHelpers(4),
  ...defMatHelpers(2),
  ...defMatHelpers(3),
  ...defMatHelpers(4),
]

/** name → FuncDecl for the lowering pass's used-set closure. */
export const DF64_FNS: ReadonlyMap<string, FuncDecl> = new Map(DF64_ORDER.map((d) => [d.name, d]))

/** Call handles for the scalar helpers, for the INTEGER flavor's twin bodies
 *  (df64-int.ts): its div/sqrt/vec-lane bodies re-emit the SAME by-name calls
 *  (df64_sub, df64_twoProd, …), which the integer registry then resolves to the
 *  integer primitives. Pure TS export — changes no emitted byte. */
export const DF64_CALLS = {
  twoSum: df64_twoSum,
  quickTwoSum: df64_quickTwoSum,
  twoProd: df64_twoProd,
  twoSqr: df64_twoSqr,
  add: df64_add,
  sub: df64_sub,
  mul: df64_mul,
  div: df64_div,
} as const
