// ═══════════════════════════════════════════════════════════════════
// ShaderVariant ← ComputeVariantAddendum merge
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 4-5 third sub-piece. Composes the products of:
//
//   - generateShaderVariant(node, palette?)          → ShaderVariant
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
import { emitComputeOutputReadExprNode } from './compute-output-binding'

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

  // Preamble merge — append the compute output storage bindings to the
  // variant's existing module-shape preamble (consts/bindings/funcs).
  const preamble = {
    ...variant.preamble,
    bindings: [...(variant.preamble.bindings ?? []), ...addendum.bindingDecls],
  }

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
    // Phase 2.5 US-006 — construct the Node directly from the
    // ComputeOutputBindingSpec rather than wrapping the addendum's
    // string via wgslRaw. The Node form emits the equivalent
    // 'unpack4x8unorm(compute_out_fill[input.feat_id])' WGSL at the
    // marker substitution site, semantic-equivalent to the legacy
    // string emit under AC6 paren-density allowance.
    fillExpr: hasFill
      ? emitComputeOutputReadExprNode(addendum.bindings.find((b) => b.paintAxis === 'fill')!)
      : variant.fillExpr,
    strokeExpr: hasStroke
      ? emitComputeOutputReadExprNode(
          addendum.bindings.find((b) => b.paintAxis === 'stroke-color')!,
        )
      : variant.strokeExpr,
    // Phase 2.5 US-002 — when the compute kernel takes over the axis,
    // the addendum produces a non-default fillExpr / strokeExpr
    // (`bindingRefs[i]` etc.) → the default-sentinel flag must clear
    // so the runtime skip-fill-draw fast path doesn't accidentally
    // drop the compute-evaluated colour. When compute doesn't touch
    // the axis, carry the source variant's flag forward unchanged.
    fillIsDefault: hasFill ? false : variant.fillIsDefault,
    strokeIsDefault: hasStroke ? false : variant.strokeIsDefault,
    uniformFields,
    // Surface the bindings on the merged variant so the runtime can
    // (a) detect "compute layout needed" via existence-check and
    // (b) iterate the (axis, group, binding) triples to attach the
    // right output buffer per slot when creating the per-tile bind
    // group. Preserve insertion order — addendum sets it from the
    // ComputePlanEntry walk, which the runtime's bind-group creator
    // expects to match the preamble decl order. Deep-copy each spec
    // so a later mutation on the addendum (e.g. caller reusing the
    // builder output) can't reach into the merged variant's state.
    computeBindings: addendum.bindings.map((b) => ({ ...b })),
  }
}
