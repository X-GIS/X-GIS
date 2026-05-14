// ═══════════════════════════════════════════════════════════════════
// Per-show merged variant builder — single API entry point for runtime
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 4-5 final compiler-side piece. Wraps the three-step
// composition the runtime would otherwise do inline:
//
//   1. Filter the scene's ComputePlanEntry[] to this show's index.
//   2. Build the addendum from those entries.
//   3. Merge into the show's legacy ShaderVariant.
//
// Each step is pure and already tested in isolation; this helper
// just chains them with early-return short-circuits for the common
// "no compute paint on this show" case so the runtime can call it
// unconditionally without measurable cost on shows that don't need
// it.
//
// The runtime is expected to call this once per show at variant-
// caching time, passing the (bindGroup, baseBinding) slots its
// chosen bind-group layout reserved for compute output buffers.

import type { ShaderVariant } from './shader-gen'
import type { ComputePlanEntry } from './compute-plan'
import { buildComputeVariantAddendum } from './compute-variant'
import { mergeComputeAddendumIntoVariant } from './compute-variant-merge'

/** Compose the per-show merged ShaderVariant. Returns the input
 *  `showVariant` by reference (no allocation) when:
 *
 *    - `scenePlan` is undefined / empty (scene has no compute paint).
 *    - No entry in `scenePlan` targets `renderNodeIndex`.
 *
 *  Otherwise filters the plan, builds the addendum at
 *  (bindGroup, baseBinding), and merges. The merged variant gets
 *  the compute-output bind decls in its preamble, the unpack4x8unorm
 *  read expressions in fillExpr/strokeExpr, and the cache key
 *  extended with the binding fingerprint.
 *
 *  `bindGroup` / `baseBinding` are runtime choices — the helper is
 *  agnostic about which bind-group layout slot the compute output
 *  buffers occupy. Pick a slot that doesn't collide with the
 *  legacy uniform / feat_data / palette bindings.
 */
export function buildPerShowMergedVariant(
  showVariant: ShaderVariant,
  scenePlan: readonly ComputePlanEntry[] | undefined,
  renderNodeIndex: number,
  bindGroup: number,
  baseBinding: number,
): ShaderVariant {
  if (!scenePlan || scenePlan.length === 0) return showVariant

  const entries = scenePlan.filter(e => e.renderNodeIndex === renderNodeIndex)
  if (entries.length === 0) return showVariant

  const addendum = buildComputeVariantAddendum(entries, bindGroup, baseBinding)
  return mergeComputeAddendumIntoVariant(showVariant, addendum)
}
