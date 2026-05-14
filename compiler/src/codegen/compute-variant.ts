// ═══════════════════════════════════════════════════════════════════
// Compute-route variant addendum builder
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 4-5 second sub-piece. Composes the P4-5a emit helpers
// into a single function that turns a per-show ComputePlanEntry
// slice into the variant-shape shader-gen already understands:
//
//   { preamble, fillExpr?, strokeExpr?, bindGroupEntries }
//
// shader-gen's existing fragment-shader specialisation pipeline
// already accepts `preamble` + `fillExpr` + `strokeExpr` (the legacy
// match()-on-fragment path emits all three). The runtime in
// renderer.ts:582 looks at the variant and:
//
//   1. Injects `preamble` after the uniforms binding.
//   2. Replaces FILL_RETURN_MARKER with `fillExpr` if non-default.
//   3. Same for strokeExpr.
//
// So if we can produce a variant-shape addendum that REPLACES the
// fill/stroke axes that route to compute with a "read out_color"
// expression — and adds the storage binding to the preamble — we
// can hook into the existing variant pipeline without modifying
// shader-gen.ts at all. shader-gen.ts integration becomes a small
// merge call ("merge legacy variant + compute addendum"), which is
// the P4-5c piece.
//
// What this module does NOT do:
//
//   - Merge with an existing variant. Caller (P4-5c) does that.
//   - Pick bind-group slots. Caller passes (bindGroup, baseBinding).
//   - Walk a Scene. Caller filters ComputePlanEntry[] to the show
//     this variant is being built for (one variant per show in
//     the existing model).

import type { ComputePlanEntry } from './compute-plan'
import {
  emitComputeOutputBindingDecl,
  emitComputeOutputReadExpr,
  makeComputeOutputBindGroupEntry,
  type ComputeOutputBindGroupEntry,
  type ComputeOutputBindingSpec,
} from './compute-output-binding'

/** Output of the addendum builder. Subset of the legacy ShaderVariant
 *  shape — fields are intentionally optional so the caller can
 *  detect "no compute paint" via the missing fillExpr/strokeExpr. */
export interface ComputeVariantAddendum {
  /** WGSL preamble — one bind decl per compute output buffer.
   *  Joined by '\n'. Empty string when no entries contribute. */
  preamble: string
  /** Fragment expression replacing `u.fill_color` for this show.
   *  `undefined` when this show's fill axis didn't route to compute. */
  fillExpr?: string
  /** Same for stroke. */
  strokeExpr?: string
  /** GPUBindGroupLayout entries the runtime must include in the
   *  bind-group layout — one per compute output buffer. */
  bindGroupEntries: ComputeOutputBindGroupEntry[]
  /** Per-axis spec → for the runtime to know WHICH output buffer to
   *  attach to each binding when creating the actual bind group. */
  bindings: ComputeOutputBindingSpec[]
}

/** The fragment shader receives `feat_id` at @location(1). All three
 *  P4-1..4 kernels write one u32 per feat_id, so the read expression
 *  always indexes by `input.feat_id`. Hoisted to a constant so the
 *  emit helpers + tests can refer to one canonical fid expression
 *  without duplicating the string. */
export const FRAGMENT_FEAT_ID_EXPR = 'input.feat_id'

/** Build the addendum from ComputePlanEntry[] filtered to a single
 *  show. Bindings are allocated sequentially starting at
 *  `baseBinding`, packed into the bind group at `bindGroup`. Caller
 *  is responsible for not collising with existing slots in that
 *  group — typically baseBinding is chosen after the existing
 *  feat_data slot (binding 1 in the legacy fragment layout).
 *
 *  When `entries` is empty (no compute paint on this show), returns
 *  an empty addendum with no preamble + no fillExpr/strokeExpr; the
 *  caller can treat this as a no-op merge.
 */
export function buildComputeVariantAddendum(
  entries: readonly ComputePlanEntry[],
  bindGroup: number,
  baseBinding: number,
): ComputeVariantAddendum {
  const preambleLines: string[] = []
  const bindGroupEntries: ComputeOutputBindGroupEntry[] = []
  const bindings: ComputeOutputBindingSpec[] = []
  let fillExpr: string | undefined
  let strokeExpr: string | undefined

  let nextBinding = baseBinding
  for (const entry of entries) {
    const spec: ComputeOutputBindingSpec = {
      paintAxis: entry.paintAxis,
      bindGroup,
      binding: nextBinding,
    }
    preambleLines.push(emitComputeOutputBindingDecl(spec))
    bindGroupEntries.push(makeComputeOutputBindGroupEntry(spec))
    bindings.push(spec)
    const readExpr = emitComputeOutputReadExpr(spec, FRAGMENT_FEAT_ID_EXPR)
    if (entry.paintAxis === 'fill') {
      fillExpr = readExpr
    } else {
      strokeExpr = readExpr
    }
    nextBinding++
  }

  return {
    preamble: preambleLines.join('\n'),
    fillExpr,
    strokeExpr,
    bindGroupEntries,
    bindings,
  }
}
