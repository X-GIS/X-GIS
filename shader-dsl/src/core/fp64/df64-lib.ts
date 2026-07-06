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
// ── The ONE-uniform guard (why every body threads `_fp64.one`) ──
// The error-free transformations below are algebraically trivial (e.g.
// `e = b - (s - a)` is 0 in real arithmetic). WGSL §15.7.5 explicitly PERMITS
// reassociation/fusion, Metal defaults to fast-math, and ANGLE's D3D compiler
// reassociates — any of which folds the error terms away and silently
// collapses df64 to f32 precision. Neither WGSL nor GLSL ES 3.00 has a
// `precise` qualifier. The one portable defense (proven by luma.gl's
// LUMA_FP64_CODE_ELIMINATION_WORKAROUND) is a runtime-opaque uniform ONE
// (value 1.0) multiplied through the EFT intermediates, so no compiler can
// cancel them at compile time. The uniform is AUTO-INJECTED by fp64Lower into
// any module that uses these helpers (pin its slot with `fp64Guard()` when an
// engine's bind-group layout demands it); the host MUST write 1.0f into it.
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
  member,
  bindingRef,
  structT,
  f32T,
  vec2fT,
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

// ── The anti-fast-math guard uniform ──

export const FP64_GUARD_NAME = '_fp64'
export const FP64_GUARD_STRUCT = 'Fp64Guard'

/** The guard struct decl — fp64Lower injects it (with the binding) into any
 *  module that uses df64 helpers; exported for the pass and for tests. */
export const FP64_GUARD_DECL: StructDecl = {
  name: FP64_GUARD_STRUCT,
  fields: [{ name: 'one', type: f32T }],
}
export const FP64_GUARD_TYPE: ShaderType = structT(FP64_GUARD_STRUCT)

export interface Fp64GuardHandle {
  readonly struct: StructDecl
  /** Alias of `struct` — the `.decl` spelling every other declarator uses. */
  readonly decl: StructDecl
  readonly type: ShaderType
  readonly binding: BindingDecl
}

/** OPTIONAL pin for the fp64 guard uniform's slot. A module that uses f64
 *  arithmetic gets `struct Fp64Guard { one: f32 }` bound as `_fp64`
 *  AUTO-INJECTED by fp64Lower (deterministically at group 0, first free
 *  binding) — authors declare NOTHING for the default. Use this declarator in
 *  `module({ uses: [...] })` only to pin the (group, binding) to an engine's
 *  fixed bind-group layout. Either way the binding shows up in reflect() as an
 *  ordinary uniform buffer, and the host MUST write 1.0f into it — the value
 *  is semantically 1.0; it exists only so downstream shader compilers cannot
 *  constant-fold the df64 error-compensation terms (see the file header). */
export function fp64Guard(at: { group: number; binding: number }): Fp64GuardHandle {
  return {
    struct: FP64_GUARD_DECL,
    decl: FP64_GUARD_DECL,
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

/** The runtime-opaque 1.0 every helper body threads through its EFT terms. */
const one = member(bindingRef(FP64_GUARD_NAME, FP64_GUARD_TYPE), 'one', f32T) as ReadonlyNode<'f32'>

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

/** a × b: twoProd of the hi words + cross terms + renormalize. */
const df64_mul = fn('df64_mul', { a: vec2fT, b: vec2fT }, (p) => {
  const prod = Var(df64_twoProd({ a: p.a.x, b: p.b.x }))
  prod.y.assign(prod.y.add(p.a.x.mul(p.b.y)))
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
]

/** name → FuncDecl for the lowering pass's used-set closure. */
export const DF64_FNS: ReadonlyMap<string, FuncDecl> = new Map(DF64_ORDER.map((d) => [d.name, d]))
