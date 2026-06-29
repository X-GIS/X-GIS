// ═══════════════════════════════════════════════════════════════════
// node-builders — compiler-side Node IR construction helpers
// ═══════════════════════════════════════════════════════════════════
//
// Phase 2.5 US-005 prep — the per-idiom Node conversion will rewrite
// each compiler emit site (processColorValue arms, buildFillExpr,
// palette-emit, categorical-encoder) from WGSL string assembly to
// DSL Node construction. The compiler can't import the runtime's
// `Node<K>` class directly (compiler tsconfig rootDir excludes
// runtime/ + a workspace value-dep would cycle); these helpers
// build the structural Expr literals + the NodeLike wrapper so the
// compiler-side codegen sites have a stable authoring surface. The
// NodeLike / Expr vocabulary lives in the permanent `../node-types`.

import type { NodeLike } from '../node-types'

// ── ShaderType mirror (matches runtime IR shapes) ──

const F32_T = { kind: 'scalar', scalar: 'f32' } as const
const I32_T = { kind: 'scalar', scalar: 'i32' } as const
const U32_T = { kind: 'scalar', scalar: 'u32' } as const
const BOOL_T = { kind: 'scalar', scalar: 'bool' } as const
const VEC4F_T = { kind: 'vec', n: 4, elem: 'f32' } as const

// ── Literals ──

export function f32Lit(v: number): NodeLike<'f32'> {
  return { expr: { op: 'lit', type: F32_T, value: v } } as NodeLike<'f32'>
}

export function i32Lit(v: number): NodeLike<'i32'> {
  return { expr: { op: 'lit', type: I32_T, value: v } } as NodeLike<'i32'>
}

export function u32Lit(v: number): NodeLike<'u32'> {
  return { expr: { op: 'lit', type: U32_T, value: v } } as NodeLike<'u32'>
}

export function boolLit(v: boolean): NodeLike<'bool'> {
  return { expr: { op: 'lit', type: BOOL_T, value: v } } as NodeLike<'bool'>
}

// ── References ──

/** Reference to a module-level const (e.g. FILL_COLOR after a preamble const
 *  decl). Mirrors runtime `constRef`. */
export function constRefVec4(name: string): NodeLike<'vec4<f32>'> {
  return { expr: { op: 'constref', type: VEC4F_T, name } } as NodeLike<'vec4<f32>'>
}

/** Reference to a uniform / storage binding field (e.g. `u.fill_color`).
 *  The dotted name carries straight through the runtime's varref emit
 *  (`u.fill_color` is emitted verbatim as a varref, matching the
 *  marker-substitution path the runtime expects). */
export function varRefVec4(name: string): NodeLike<'vec4<f32>'> {
  return { expr: { op: 'varref', type: VEC4F_T, name } } as NodeLike<'vec4<f32>'>
}

// ── Constructors ──

/** vec4<f32>(r, g, b, a) literal. Used by the constant-fill arm and the
 *  buildFillExpr composition target. */
export function vec4f(r: NodeLike<'f32'>, g: NodeLike<'f32'>, b: NodeLike<'f32'>, a: NodeLike<'f32'>): NodeLike<'vec4<f32>'> {
  return {
    expr: {
      op: 'construct',
      type: VEC4F_T,
      args: [r.expr, g.expr, b.expr, a.expr],
    },
  } as NodeLike<'vec4<f32>'>
}

/** vec4<f32> literal from an RGBA tuple — convenience for the constant-fill
 *  path which receives `value.rgba` directly. */
export function vec4fFromRgba(rgba: readonly [number, number, number, number]): NodeLike<'vec4<f32>'> {
  return vec4f(f32Lit(rgba[0]), f32Lit(rgba[1]), f32Lit(rgba[2]), f32Lit(rgba[3]))
}

/** match-expression over an i32 scrutinee producing a vec4<f32> — mirrors the
 *  runtime `matchExpr` builder (same Expr shape). The backend's `lowerModule`
 *  pass (run inside `emitModule`) hoists this into a `var _mr_N: vec4<f32>` +
 *  `switch` that writes each case's value into the slot, exactly the shape the
 *  legacy hand-built `var _mc; if(scrutinee == id){...}` chain produced. Cases
 *  are `[categoryId, colorNode]`; `fallback` is the `default` arm. */
export function matchVec4(
  scrutinee: NodeLike<'i32'>,
  cases: ReadonlyArray<readonly [number, NodeLike<'vec4<f32>'>]>,
  fallback: NodeLike<'vec4<f32>'>,
): NodeLike<'vec4<f32>'> {
  return {
    expr: {
      op: 'matchExpr',
      type: VEC4F_T,
      scrutinee: scrutinee.expr,
      cases: cases.map(([n, v]) => [n, v.expr] as const),
      default: fallback.expr,
    },
  } as NodeLike<'vec4<f32>'>
}

/** Reference to a uniform / storage binding scalar (`u.opacity`,
 *  `OPACITY` after a preamble const decl, etc.). The dotted name
 *  passes through verbatim as a varref. */
export function refF32(name: string): NodeLike<'f32'> {
  return { expr: { op: 'varref', type: F32_T, name } } as NodeLike<'f32'>
}

// ── Compositions ──

/** vec4(color.rgb, color.a * opacity) — the buildFillExpr composition
 *  target. WGSL accepts `vec4<f32>(vec3<f32>, f32)` directly, so the
 *  emitted form is byte-identical to the legacy string-emit shape
 *  the snapshot baselines were captured against. */
export function composeFillVec4(color: NodeLike<'vec4<f32>'>, opacity: NodeLike<'f32'>): NodeLike<'vec4<f32>'> {
  const VEC3F_T = { kind: 'vec', n: 3, elem: 'f32' } as const
  const rgb = { op: 'member', type: VEC3F_T, base: color.expr, field: 'rgb' } as const
  const aChan = { op: 'member', type: F32_T, base: color.expr, field: 'a' } as const
  const mulA = { op: 'binop', type: F32_T, bop: '*', a: aChan, b: opacity.expr } as const
  return {
    expr: {
      op: 'construct',
      type: VEC4F_T,
      args: [rgb, mulA],
    },
  } as NodeLike<'vec4<f32>'>
}

// ── Arithmetic / casts (US-005 prep for the data-driven / categorical idioms) ──

/** Cast to u32. Mirrors runtime `toU32` — wraps the input Expr in a
 *  `u32(...)` call which the wgsl backend emits verbatim. */
export function toU32(x: NodeLike<string>): NodeLike<'u32'> {
  return { expr: { op: 'call', type: U32_T, fn: 'u32', args: [x.expr] } } as NodeLike<'u32'>
}

/** Cast to i32. */
export function toI32(x: NodeLike<string>): NodeLike<'i32'> {
  return { expr: { op: 'call', type: I32_T, fn: 'i32', args: [x.expr] } } as NodeLike<'i32'>
}

/** f32 binop helper — produces `(a <bop> b)` as a Node. */
function f32Binop(bop: '+' | '-' | '*' | '/' | '%', a: NodeLike<'f32'>, b: NodeLike<'f32'>): NodeLike<'f32'> {
  return { expr: { op: 'binop', type: F32_T, bop, a: a.expr, b: b.expr } } as NodeLike<'f32'>
}

/** u32 binop helper. */
function u32Binop(bop: '+' | '-' | '*' | '/' | '%', a: NodeLike<'u32'>, b: NodeLike<'u32'>): NodeLike<'u32'> {
  return { expr: { op: 'binop', type: U32_T, bop, a: a.expr, b: b.expr } } as NodeLike<'u32'>
}

export const f32Add = (a: NodeLike<'f32'>, b: NodeLike<'f32'>) => f32Binop('+', a, b)
export const f32Sub = (a: NodeLike<'f32'>, b: NodeLike<'f32'>) => f32Binop('-', a, b)
export const f32Mul = (a: NodeLike<'f32'>, b: NodeLike<'f32'>) => f32Binop('*', a, b)
export const f32Div = (a: NodeLike<'f32'>, b: NodeLike<'f32'>) => f32Binop('/', a, b)
export const u32Add = (a: NodeLike<'u32'>, b: NodeLike<'u32'>) => u32Binop('+', a, b)
export const u32Mul = (a: NodeLike<'u32'>, b: NodeLike<'u32'>) => u32Binop('*', a, b)
export const u32Mod = (a: NodeLike<'u32'>, b: NodeLike<'u32'>) => u32Binop('%', a, b)

/** Unary negation `(-x)`. Mirrors the IR `unop` (negation-only). */
export function negF32(x: NodeLike<'f32'>): NodeLike<'f32'> {
  return { expr: { op: 'unop', type: F32_T, a: x.expr } } as NodeLike<'f32'>
}

/** A generic f32-returning builtin / user-fn call `fn(args...)`. The args carry
 *  their own types; the result is annotated f32 — the only return type the
 *  fragment data-driven expression compiler produces. The fn NAME is spelled by
 *  the package WGSL backend's intrinsic registry, not here. */
export function callF32(fn: string, args: ReadonlyArray<NodeLike<string>>): NodeLike<'f32'> {
  return { expr: { op: 'call', type: F32_T, fn, args: args.map((a) => a.expr) } } as NodeLike<'f32'>
}

/** max(a, b) for f32 — the f32 encoding of logical OR (`||`). */
export function maxF32(a: NodeLike<'f32'>, b: NodeLike<'f32'>): NodeLike<'f32'> {
  return callF32('max', [a, b])
}

/** floored modulo `a - b * floor(a / b)` — NOT the `%` operator.
 *
 *  The `%` BinOp is deliberately avoided: WGSL `%` and the CPU oracle's JS `%`
 *  are TRUNCATED remainder (sign of dividend), GLSL ES rejects `%` on floats
 *  outright, so a raw `%` breaks the three-backend single-emit + CPU↔GPU parity
 *  contract. This floored form composes only portable ops (`-`/`*`/`/`/`floor`,
 *  all three backends + the oracle evaluate them identically) and matches the
 *  codebase's canonical wrap (`value - floor(value / period) * period`). */
export function f32Mod(a: NodeLike<'f32'>, b: NodeLike<'f32'>): NodeLike<'f32'> {
  return f32Sub(a, f32Mul(b, callF32('floor', [f32Div(a, b)])))
}

/** A comparison producing a WGSL bool (`(a <cop> b)`). */
export function compareToBool(
  a: NodeLike<'f32'>,
  cop: '<' | '>' | '<=' | '>=' | '==' | '!=',
  b: NodeLike<'f32'>,
): NodeLike<'bool'> {
  return { expr: { op: 'compare', type: BOOL_T, cop, a: a.expr, b: b.expr } } as NodeLike<'bool'>
}

/** select(ifFalse, ifTrue, cond) returning f32 — the boolean→value bridge the
 *  data-driven expression compiler uses to keep every value f32. */
export function selectF32(
  ifFalse: NodeLike<'f32'>,
  ifTrue: NodeLike<'f32'>,
  cond: NodeLike<'bool'>,
): NodeLike<'f32'> {
  return {
    expr: { op: 'select', type: F32_T, cond: cond.expr, ifTrue: ifTrue.expr, ifFalse: ifFalse.expr },
  } as NodeLike<'f32'>
}

/** A binary op that emits `(a <op> b)` verbatim, choosing the IR node by op
 *  class (arithmetic → binop, comparison → compare, logical → logical). Used by
 *  the user-fn inliner, which historically embedded comparison/logical operators
 *  verbatim (NOT through the f32 select() bridge). The `type` is annotated f32
 *  because emit ignores the type for these ops — the spelling is `(a op b)`. */
export function binaryVerbatimF32(a: NodeLike<'f32'>, op: string, b: NodeLike<'f32'>): NodeLike<'f32'> {
  // `%` routes through the floored-modulo expression (portable across the three
  // backends); the raw `%` BinOp is never emitted for f32.
  if (op === '%') return f32Mod(a, b)
  if (op === '+' || op === '-' || op === '*' || op === '/') {
    return { expr: { op: 'binop', type: F32_T, bop: op, a: a.expr, b: b.expr } } as NodeLike<'f32'>
  }
  if (op === '<' || op === '>' || op === '<=' || op === '>=' || op === '==' || op === '!=') {
    return { expr: { op: 'compare', type: F32_T, cop: op, a: a.expr, b: b.expr } } as NodeLike<'f32'>
  }
  if (op === '&&' || op === '||') {
    return { expr: { op: 'logical', type: F32_T, lop: op, a: a.expr, b: b.expr } } as NodeLike<'f32'>
  }
  throw new Error(`binaryVerbatimF32: unsupported operator ${op}`)
}

/** Array index access (`base[idx]`). Returns a Node of the elemKey
 *  generic. The elemKey is opaque to the compiler-side helper — the
 *  caller annotates the result type. */
export function arrayIndex<E extends string>(base: NodeLike<string>, idx: NodeLike<'u32'> | NodeLike<'i32'>, elemTypeKey: E): NodeLike<E> {
  // Synthesize a minimal ShaderType for the element. Use vec4f as
  // the default for the palette / categorical color array case;
  // u32 / i32 for the compute output / feat_data lookup cases;
  // f32 otherwise. Runtime emit cares about index op shape, not
  // the elem type, so the simplification is safe.
  const elemT =
    elemTypeKey === 'vec4<f32>' ? VEC4F_T :
    elemTypeKey === 'u32' ? U32_T :
    elemTypeKey === 'i32' ? I32_T :
    F32_T
  return { expr: { op: 'index', type: elemT, base: base.expr, idx: idx.expr } } as NodeLike<E>
}

/** Reference to the `feat_data` storage buffer (typed as array<f32>).
 *  Used as the base of feat_data lookup index ops. */
export function featDataBindingRef(): NodeLike<'array<f32>'> {
  return {
    expr: {
      op: 'varref',
      type: { kind: 'array', elem: F32_T },
      name: 'feat_data',
    },
  } as NodeLike<'array<f32>'>
}

/** Reference to `input.feat_id` (the vertex param's per-feature index).
 *  Used in the feat_data[input.feat_id * STRIDE + offset] address calc. */
export function inputFeatIdRef(): NodeLike<'u32'> {
  return {
    expr: {
      op: 'member',
      type: U32_T,
      base: { op: 'varref', type: { kind: 'struct', name: 'VertexOutput' }, name: 'input' },
      field: 'feat_id',
    },
  } as NodeLike<'u32'>
}

/** Construct the feat_data[input.feat_id * STRIDE + offset] f32 lookup
 *  Node for a single field — mirrors exprToWGSL's FieldAccess emit. */
export function featDataField(fieldName: string, fieldMap: Map<string, number>): NodeLike<'f32'> | null {
  const offset = fieldMap.get(fieldName)
  if (offset === undefined) return null
  const stride = fieldMap.size
  const addr = u32Add(u32Mul(inputFeatIdRef(), u32Lit(stride)), u32Lit(offset))
  return arrayIndex<'f32'>(featDataBindingRef() as NodeLike<string>, addr, 'f32')
}

// ── mix / clamp builtins (gradient + scale idioms) ──

/** mix(low, high, t) for vec4<f32> args + scalar t. */
export function mix4(low: NodeLike<'vec4<f32>'>, high: NodeLike<'vec4<f32>'>, t: NodeLike<'f32'>): NodeLike<'vec4<f32>'> {
  return {
    expr: { op: 'call', type: VEC4F_T, fn: 'mix', args: [low.expr, high.expr, t.expr] },
  } as NodeLike<'vec4<f32>'>
}

/** clamp(x, lo, hi) for f32 scalars. */
export function clampF32(x: NodeLike<'f32'>, lo: NodeLike<'f32'>, hi: NodeLike<'f32'>): NodeLike<'f32'> {
  return {
    expr: { op: 'call', type: F32_T, fn: 'clamp', args: [x.expr, lo.expr, hi.expr] },
  } as NodeLike<'f32'>
}

// ── Texture sample (palette atlas idiom) ──

const VEC2F_T = { kind: 'vec', n: 2, elem: 'f32' } as const

/** vec2<f32>(x, y) literal. */
export function vec2f(x: NodeLike<'f32'>, y: NodeLike<'f32'>): NodeLike<'vec2<f32>'> {
  return {
    expr: { op: 'construct', type: VEC2F_T, args: [x.expr, y.expr] },
  } as NodeLike<'vec2<f32>'>
}

/** Texture binding ref (texture_2d<f32>). */
export function varRefTexture2d(name: string): NodeLike<'texture_2d<f32>'> {
  return {
    expr: { op: 'varref', type: { kind: 'texture', dim: '2d', elem: 'f32' }, name },
  } as NodeLike<'texture_2d<f32>'>
}

/** Sampler binding ref. */
export function varRefSampler(name: string): NodeLike<'sampler'> {
  return {
    expr: { op: 'varref', type: { kind: 'sampler' }, name },
  } as NodeLike<'sampler'>
}

/** textureSampleLevel(tex, sampler, uv, lod) returning vec4<f32>. */
export function textureSampleLevelVec4(
  tex: NodeLike<'texture_2d<f32>'>,
  sampler: NodeLike<'sampler'>,
  uv: NodeLike<'vec2<f32>'>,
  lod: NodeLike<'f32'>,
): NodeLike<'vec4<f32>'> {
  return {
    expr: { op: 'call', type: VEC4F_T, fn: 'textureSampleLevel', args: [tex.expr, sampler.expr, uv.expr, lod.expr] },
  } as NodeLike<'vec4<f32>'>
}

/** unpack4x8unorm(u32) -> vec4<f32> builtin (compute output read path). */
export function unpack4x8unormVec4(u: NodeLike<'u32'>): NodeLike<'vec4<f32>'> {
  return {
    expr: { op: 'call', type: VEC4F_T, fn: 'unpack4x8unorm', args: [u.expr] },
  } as NodeLike<'vec4<f32>'>
}

/** storage<read> array<u32> binding ref (compute output buffers). */
export function varRefArrayU32(name: string): NodeLike<'array<u32>'> {
  return {
    expr: { op: 'varref', type: { kind: 'array', elem: U32_T }, name },
  } as NodeLike<'array<u32>'>
}
