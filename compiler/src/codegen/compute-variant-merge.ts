// ═══════════════════════════════════════════════════════════════════
// ShaderVariant ← ComputeVariantAddendum merge
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 4-5 third sub-piece. Composes the products of:
//
//   - generateShaderVariant(node, fnEnv?, palette?)  → ShaderVariant
//   - buildComputeVariantAddendum(entries, bg, base) → ComputeVariantAddendum
//
// into a single ShaderVariant whose fragment-shader emission uses
// the compute kernel's pre-evaluated `out_color` buffer for fill /
// stroke (when those axes routed to compute), and the legacy
// expressions otherwise.
//
// Merge rules:
//
//   preamble        — concat legacy + addendum bind decls (need
//                     both: legacy may declare feat_data, addendum
//                     declares compute_out_*).
//   fillExpr        — addendum overrides if present, else legacy.
//                     The compute kernel already evaluated the fill,
//                     so the fragment just reads + unpacks.
//   strokeExpr      — same.
//   fillPreamble    — DROPPED when fillExpr overridden — the legacy
//                     preamble was the if-else chain the inline
//                     match() emit needed; compute path doesn't.
//   strokePreamble  — same.
//   needsFeatureBuffer / featureFields — unchanged. The compute
//                     kernel reads its own feat_data via separate
//                     bindings + plumbing; fragment-side
//                     featureFields is for the LEGACY feat_data
//                     storage buffer (still used when axes mix
//                     compute + legacy paths).
//   categoryOrder   — unchanged. Compute kernel runs its own
//                     categoryOrder (carried on ComputePlanEntry);
//                     the legacy categoryOrder is only consumed by
//                     the worker for the legacy fragment path.
//   palette fields  — unchanged. Compute path doesn't read the
//                     gradient atlas; those fields tell the runtime
//                     whether to bind the atlas at all.
//   uniformFields   — when fill / stroke overridden, the compute
//                     output replaces the corresponding uniform
//                     read, so `fill_color` / `stroke_color` is
//                     pruned from the uniformFields list (the
//                     runtime can skip writing it per frame).
//   key             — extended with the compute spec fingerprint so
//                     the variant cache distinguishes compute vs
//                     non-compute pipelines for the same paint
//                     expression.
//
// Pure: no IR walk, no GPU. Caller orchestrates the legacy +
// compute halves and passes them in.

import type { ShaderVariant } from './shader-gen'
import type { ComputeVariantAddendum } from './compute-variant'

/** Merge a legacy ShaderVariant with the compute-output addendum.
 *  Returns a new ShaderVariant — original is not mutated. */
export function mergeComputeAddendumIntoVariant(
  variant: ShaderVariant,
  addendum: ComputeVariantAddendum,
): ShaderVariant {
  const hasFill = addendum.fillExpr !== undefined
  const hasStroke = addendum.strokeExpr !== undefined

  // Empty addendum → return the legacy variant unchanged. Identity
  // preserved so the caller can call this unconditionally without
  // measurable cost.
  if (!hasFill && !hasStroke) {
    return variant
  }

  // Preamble concatenation — legacy first, addendum second. Both are
  // strings with their own internal newline structure; join with a
  // newline so adjacent decls don't fuse.
  const preamble = variant.preamble.length === 0
    ? addendum.preamble
    : `${variant.preamble}\n${addendum.preamble}`

  // Prune uniform fields whose axis the compute path now owns. The
  // runtime uses `uniformFields` to decide which u.* slots get
  // updated per frame; freezing the slot keeps the value at its
  // last write (don't care, since the fragment never reads it).
  const uniformFields = variant.uniformFields.filter((f) => {
    if (hasFill && f === 'fill_color') return false
    if (hasStroke && f === 'stroke_color') return false
    return true
  })

  // Cache key extension. The fingerprint encodes the (group, binding,
  // axis) triples so two scenes with structurally identical legacy
  // variants but different compute bindings get distinct pipelines.
  const computeFingerprint = addendum.bindings
    .map((b) => `${b.paintAxis[0]}${b.bindGroup}.${b.binding}`)
    .sort()
    .join(',')
  const key = `${variant.key}|c:${computeFingerprint}`

  return {
    ...variant,
    key,
    preamble,
    fillExpr: hasFill ? addendum.fillExpr! : variant.fillExpr,
    strokeExpr: hasStroke ? addendum.strokeExpr! : variant.strokeExpr,
    // The legacy match() / if-else preamble is irrelevant when the
    // compute kernel evaluated the colour upstream. Drop them so the
    // emitted shader doesn't carry dead helper-var declarations.
    fillPreamble: hasFill ? undefined : variant.fillPreamble,
    strokePreamble: hasStroke ? undefined : variant.strokePreamble,
    uniformFields,
  }
}
