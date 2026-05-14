// ═══════════════════════════════════════════════════════════════════
// annotate-deps — Scene-wide dependency bitset annotation pass
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 0 step 1b (wild-finding-starlight). Walks a Scene's
// paint-property surfaces and collects the dependency bitset for
// every PropertyShape / ColorValue / DataExpr encountered. Output
// is a side-table annotation (WeakMap by reference) — consumers
// opt in by carrying the `DepsAnnotation` parameter.
//
// Why a pass (vs the existing on-demand `getColorDeps` /
// `getPropertyShapeDeps` from `../deps.ts`):
//
//   - Diagnostics + analyses care about Scene-wide histograms
//     ("what fraction of paint axes are ZOOM-only? FEATURE? mixed?").
//     The annotation gives a cached, indexed view callers can query
//     without re-walking the Scene per question.
//
//   - Forward-looking consumers: P3 (storage texture stops baker)
//     uses `deps ⊆ {ZOOM}` to decide eligibility; P4 (compute eval
//     router) uses `Dep.FEATURE` to gate the kernel path; P6
//     (setPaintProperty incremental recompile) uses `Dep.NONE` to
//     decide whether a value change can be a tier-0 palette
//     writeTexture vs a full variant rebuild. All three already
//     work via `paint-routing` + per-call `getColorDeps`; this pass
//     consolidates the analysis so they can rebuild faster from a
//     prebuilt table.
//
//   - Mirror of `apply-cse.ts` (P0 step 3b). The two annotation
//     side tables share a shape — diagnostics consumers walk both
//     in parallel to produce reports like "147 ZOOM-only fills, of
//     which 23 share a canonical AST".
//
// What this module DOES NOT do:
//
//   - Mutate the Scene / IR. Output is pure data.
//
//   - Annotate AST nodes (Expr leaves) individually. Existing
//     analyses operate at the PropertyShape / ColorValue / DataExpr
//     granularity; AST-level deps are derivable on demand via
//     `getDataExprDeps`.
//
//   - Replace the on-demand functions. They're still the most
//     ergonomic for single-site checks; the pass is for bulk
//     consumers.

import type { Scene, RenderNode, ColorValue, DataExpr } from '../render-node'
import type { PropertyShape } from '../property-types'
import { getColorDeps, getPropertyShapeDeps, getDataExprDeps, type DepBits } from '../deps'

/** Per-paint-axis dependency entry. The `value` is the input shape
 *  the deps were derived from — caller can re-query without holding
 *  the original Scene reference. `bits` is the precomputed DepBits. */
export interface DepsEntry<V> {
  value: V
  bits: DepBits
}

/** Aggregate annotation for a single RenderNode. Mirrors the paint
 *  axes the existing renderers consume. Missing keys mean "absent
 *  on this node" (e.g. `fill` is undefined when `node.fill.kind ===
 *  'none'` — the pass omits the entry to keep the table dense). */
export interface NodeDepsAnnotation {
  fill?: DepsEntry<ColorValue>
  strokeColor?: DepsEntry<ColorValue>
  opacity?: DepsEntry<PropertyShape<number>>
  strokeWidth?: DepsEntry<PropertyShape<number>>
  /** Filter expression — boolean predicate. */
  filter?: DepsEntry<DataExpr>
  /** Geometry override expression (point shows). */
  geometry?: DepsEntry<DataExpr>
}

/** Scene-level annotation. Indexed by `renderNodeIndex` so callers
 *  who iterate scene.renderNodes in order can access dep info by
 *  position. `byNode` length matches `scene.renderNodes.length`
 *  exactly. */
export interface DepsAnnotation {
  /** One entry per RenderNode, indexed by position. */
  byNode: readonly NodeDepsAnnotation[]
  /** Histogram of `DepBits` values across every entry actually
   *  populated. Diagnostic — lets consumers ask "how many shapes
   *  are ZOOM-only" in O(1). Keys are stringified bit values; use
   *  `Dep.X` from `../deps` to construct lookups. */
  histogram: Record<string, number>
}

/** Build the annotation for the Scene. Pure — input is not modified. */
export function annotateDeps(scene: Scene): DepsAnnotation {
  const byNode: NodeDepsAnnotation[] = []
  const histogram: Record<string, number> = {}
  const bump = (b: DepBits): void => {
    const k = String(b)
    histogram[k] = (histogram[k] ?? 0) + 1
  }

  for (const node of scene.renderNodes) {
    const entry: NodeDepsAnnotation = {}

    // Color axes — skip `kind === 'none'` so the table stays dense.
    if (node.fill.kind !== 'none') {
      const bits = getColorDeps(node.fill)
      entry.fill = { value: node.fill, bits }
      bump(bits)
    }
    if (node.stroke.color.kind !== 'none') {
      const bits = getColorDeps(node.stroke.color)
      entry.strokeColor = { value: node.stroke.color, bits }
      bump(bits)
    }

    // Numeric PropertyShape axes — always present (the union has no
    // 'none' variant). Constant shapes contribute DEPS_NONE which is
    // still worth recording for the histogram.
    {
      const bits = getPropertyShapeDeps(node.opacity)
      entry.opacity = { value: node.opacity, bits }
      bump(bits)
    }
    {
      const bits = getPropertyShapeDeps(node.stroke.width)
      entry.strokeWidth = { value: node.stroke.width, bits }
      bump(bits)
    }

    // DataExpr axes — present iff the user authored an expression.
    if (node.filter) {
      const bits = getDataExprDeps(node.filter)
      entry.filter = { value: node.filter, bits }
      bump(bits)
    }
    if (node.geometry) {
      const bits = getDataExprDeps(node.geometry)
      entry.geometry = { value: node.geometry, bits }
      bump(bits)
    }

    byNode.push(entry)
  }

  return { byNode, histogram }
}

/** Convenience predicate — true iff the node's fill is ZOOM-only
 *  (or constant). Useful for P3 stops-baker eligibility checks. */
export function fillIsZoomOnly(node: NodeDepsAnnotation): boolean {
  if (!node.fill) return true  // no fill → trivially "no extra deps"
  return (node.fill.bits & ~/* ZOOM */ 1) === 0
}

/** Convenience predicate — true iff any paint axis on the node
 *  carries the FEATURE bit. Useful for P4 compute-eval router
 *  gating ("does this layer need a per-feature dispatch?"). */
export function hasFeatureDep(node: NodeDepsAnnotation): boolean {
  const FEATURE = 1 << 2
  for (const k of ['fill', 'strokeColor', 'opacity', 'strokeWidth', 'filter', 'geometry'] as const) {
    const e = node[k]
    if (e && (e.bits & FEATURE) !== 0) return true
  }
  return false
}
