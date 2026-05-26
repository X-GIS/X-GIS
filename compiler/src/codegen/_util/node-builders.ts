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
// migration sites have a stable authoring surface.
//
// REMOVED IN STEP 14 with the rest of the `_back-compat/` directory
// once US-008's polygon DSL composer accepts Node values directly
// (at which point the compiler imports from `@xgis/runtime` via the
// then-collapsed cycle).

import type { NodeLike } from '../_back-compat/node-to-wgsl-string'

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

// ── Compositions ──

/** vec4(color.rgb, color.a * opacity) — the buildFillExpr composition
 *  target. */
export function composeFillVec4(color: NodeLike<'vec4<f32>'>, opacity: NodeLike<'f32'>): NodeLike<'vec4<f32>'> {
  const rgb = { op: 'member', type: { kind: 'vec', n: 3, elem: 'f32' }, base: color.expr, field: 'rgb' } as const
  const aChan = { op: 'member', type: F32_T, base: color.expr, field: 'a' } as const
  const mulA = { op: 'binop', type: F32_T, bop: '*', a: aChan, b: opacity.expr } as const
  return {
    expr: {
      op: 'construct',
      type: VEC4F_T,
      args: [
        { op: 'member', type: F32_T, base: rgb, field: 'x' },
        { op: 'member', type: F32_T, base: rgb, field: 'y' },
        { op: 'member', type: F32_T, base: rgb, field: 'z' },
        mulA,
      ],
    },
  } as NodeLike<'vec4<f32>'>
}
