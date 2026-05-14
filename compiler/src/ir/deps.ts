// ═══════════════════════════════════════════════════════════════════
// Dependency annotation — multi-axis bitset model
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 0 component. Models a paint property's evaluation
// dependencies as a bitset over four orthogonal axes:
//
//   ZOOM    — depends on camera.zoom (per-frame)
//   TIME    — depends on animation clock (per-frame)
//   FEATURE — depends on per-feature attributes (per-feature × per-frame)
//   (none)  — pure compile-time constant; never re-evaluated
//
// Two properties with the same `DepBits` value have the same
// invalidation profile — a downstream pass that's deciding where to
// store / when to evaluate / how to route a value can branch on the
// bitset without re-traversing the AST or the PropertyShape kind.
//
// Why a bitset and not a flat enum (existing `ExprClass` in
// `./classify.ts`):
//
//   - Composability. The existing classifier collapses zoom+feature
//     into a single "per-feature-gpu" bucket; the bitset preserves
//     both bits so a P3 stops-baker can refuse to bake stops whose
//     deps include FEATURE, even when ZOOM is also present.
//
//   - Time axis. The existing classifier omits time entirely (every
//     time-animated value comes through PropertyShape kinds that
//     classify never sees). Bitset surfaces it as a first-class bit.
//
//   - Future-proof for ConstantPalettes / G-buffer / compute passes
//     that key on "exactly NONE deps" or "exactly {ZOOM}".
//
// What this module DOES NOT do:
//
//   - Mutate IR. `getColorDeps` / `getPropertyShapeDeps` are pure
//     derivations from the input. P0 keeps annotation passive; if
//     downstream passes want cached deps they can attach via separate
//     IR fields later.
//
//   - Replace `classifyExpr`. That AST-level classifier is still
//     used by the existing optimize.ts data-driven fold path. Deps
//     reads its result to recover the bitset for data-driven shapes,
//     keeping a single source of truth for AST classification.
//
//   - CSE / canonicalisation. Plan calls those out as separate
//     P0 components landing on top of this module.

import type { ColorValue, DataExpr } from './render-node'
import type { PropertyShape } from './property-types'
import { classifyExpr, type FnEnv } from './classify'

/** Dependency bitset. Pack the four orthogonal axes into one number
 *  so callers can test / combine in O(1). Values are powers of two —
 *  combinations form a 4-bit lattice (NONE=0 .. all=15). */
export const Dep = {
  NONE: 0 as const,
  ZOOM: 1 << 0,
  TIME: 1 << 1,
  FEATURE: 1 << 2,
} as const

export type DepBits = number

/** Predicate helpers. Branding-light — DepBits is just `number`. */
export function hasDep(bits: DepBits, dep: number): boolean {
  return (bits & dep) !== 0
}

/** Union — combine two dependency sets. Standard `|` semantics; the
 *  named function reads better at call sites and lets us add invariant
 *  assertions later if needed. */
export function mergeDeps(a: DepBits, b: DepBits): DepBits {
  return a | b
}

/** Convenience constructors for the common cases. */
export const DEPS_NONE: DepBits = Dep.NONE
export const DEPS_ZOOM: DepBits = Dep.ZOOM
export const DEPS_TIME: DepBits = Dep.TIME
export const DEPS_FEATURE: DepBits = Dep.FEATURE
export const DEPS_ZOOM_TIME: DepBits = Dep.ZOOM | Dep.TIME
export const DEPS_ZOOM_FEATURE: DepBits = Dep.ZOOM | Dep.FEATURE

/** Derive a DataExpr's dependency bitset by mapping the AST-level
 *  classifier's verdict. The four legacy ExprClass values collapse
 *  zoom+feature into one bucket; we recover the bits one rung up by
 *  treating `per-feature-*` as FEATURE (plus ZOOM iff the AST also
 *  references `zoom`). The latter case isn't reported by classifyExpr
 *  today — it always merges to the heavier `per-feature-*` class —
 *  so as a conservative under-approximation we mark FEATURE only.
 *  Downstream passes that need exact ZOOM-bit precision can ride
 *  on the existing `expr.classification` flag plus a one-off ast walk. */
export function getDataExprDeps(expr: DataExpr, fnEnv?: FnEnv): DepBits {
  const cls = classifyExpr(expr.ast, fnEnv)
  switch (cls) {
    case 'constant': return Dep.NONE
    case 'zoom-dependent': return Dep.ZOOM
    case 'per-feature-gpu':
    case 'per-feature-cpu':
      // FEATURE alone — the existing classifier doesn't split out
      // the (zoom AND feature) sub-case; treat as FEATURE-only to
      // preserve conservatism. Refine in a follow-up if a consumer
      // proves it needs the distinction.
      return Dep.FEATURE
  }
}

/** Derive a ColorValue's dependency bitset. Mirrors PropertyShape's
 *  five-kind union plus the legacy ColorValue `none` and `conditional`
 *  variants (lower.ts maintains them for non-shape consumers). */
export function getColorDeps(value: ColorValue, fnEnv?: FnEnv): DepBits {
  switch (value.kind) {
    case 'none':
    case 'constant':
      return Dep.NONE
    case 'zoom-interpolated':
      return Dep.ZOOM
    case 'time-interpolated':
      return Dep.TIME
    case 'data-driven':
      return getDataExprDeps(value.expr, fnEnv)
    case 'conditional': {
      // ConditionalBranch is `{ field: string; value: ColorValue }` —
      // matching on a per-feature property is FEATURE-dependent by
      // definition; each branch value recurses. Fallback recurses too.
      // Walk exhaustively so the overall bitset covers every leaf the
      // conditional can take.
      let bits: DepBits = Dep.FEATURE
      for (const br of value.branches) {
        bits = mergeDeps(bits, getColorDeps(br.value, fnEnv))
      }
      bits = mergeDeps(bits, getColorDeps(value.fallback, fnEnv))
      return bits
    }
  }
}

/** Derive any PropertyShape<T>'s dependency bitset. The five kinds
 *  map one-to-one onto axis bits; data-driven recurses through
 *  classifyExpr like ColorValue. */
export function getPropertyShapeDeps<T>(
  shape: PropertyShape<T>,
  fnEnv?: FnEnv,
): DepBits {
  switch (shape.kind) {
    case 'constant': return Dep.NONE
    case 'zoom-interpolated': return Dep.ZOOM
    case 'time-interpolated': return Dep.TIME
    case 'zoom-time': return DEPS_ZOOM_TIME
    case 'data-driven': return getDataExprDeps(shape.expr, fnEnv)
  }
}

/** Pretty-print a DepBits for diagnostics / test assertions. Returns
 *  a stable, sorted, comma-joined name list; "none" for empty. */
export function formatDeps(bits: DepBits): string {
  if (bits === Dep.NONE) return 'none'
  const parts: string[] = []
  if (hasDep(bits, Dep.ZOOM)) parts.push('zoom')
  if (hasDep(bits, Dep.TIME)) parts.push('time')
  if (hasDep(bits, Dep.FEATURE)) parts.push('feature')
  return parts.join('+')
}

/** True iff the bits set on `inner` are a subset of those on `outer`.
 *  Useful for predicate "is this shape eligible for X" checks where
 *  X requires deps ⊆ {expected}. */
export function depsSubsetOf(inner: DepBits, outer: DepBits): boolean {
  return (inner & ~outer) === 0
}
