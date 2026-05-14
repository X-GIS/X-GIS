// ═══════════════════════════════════════════════════════════════════
// Scene → ComputeKernel plan
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 4 sub-step. The final pure-compiler piece before the
// runtime scheduler. Composes the three modules we've shipped:
//
//   paint-routing   — "this paint value is compute-feature"
//   compute-lowering — ColorValue / DataExpr → kernel spec
//   compute-gen     — kernel spec → WGSL + entry-point metadata
//
// into a single Scene-level walk that produces a ComputePlanEntry[]
// listing every (renderNodeIndex, paintAxis) pair that needs a
// compute kernel. The runtime consumes this list once at scene-
// compile time and reuses it per frame; per-frame work is just the
// dispatch (feature data is already on GPU, kernel is already
// compiled).
//
// What this module does NOT do:
//
//   - Touch GPU. Output is pure data.
//   - Decide tile-level dispatch scheduling — that's the runtime's
//     job. The plan only says "kernel K is needed by show S's fill
//     axis"; the runtime decides when to run it.
//   - Dedup kernels via CSE. Two identical match() expressions
//     produce two entries today; CSE (P0 step 3) can fold them in
//     a later pass.
//
// Paint axes scanned:
//
//   - node.fill       (ColorValue)
//   - node.stroke.color (ColorValue)
//
// Numeric axes (opacity, strokeWidth, size) are scanned by router
// but rejected at lowering — there's no scalar-output compute
// kernel yet (compute-gen only emits pack4x8unorm color kernels).
// Those axes route to cpu-uniform for now and never appear in the
// plan.

import type { RenderNode, Scene } from '../ir/render-node'
import {
  routeColorValue,
  routeIsCompute,
} from './paint-routing'
import {
  lowerConditionalColorToTernary,
  lowerMatchColorToMatch,
} from './compute-lowering'
import {
  emitMatchComputeKernel,
  emitTernaryComputeKernel,
  type ComputeKernel,
} from './compute-gen'

/** Which paint axis on a RenderNode the entry targets. The runtime
 *  needs to know this so it can bind the kernel's `out_color`
 *  buffer to the right fragment-shader uniform slot. */
export type PaintAxis = 'fill' | 'stroke-color'

/** One kernel + its source coordinates. The runtime walks this list
 *  at compile time to (1) compile every kernel module, (2) allocate
 *  one output buffer per entry, (3) register the buffer with the
 *  fragment-shader bind groups for the target (renderNodeIndex,
 *  paintAxis). */
export interface ComputePlanEntry {
  /** Index into Scene.renderNodes — the show whose paint axis this
   *  kernel evaluates. Index (not id) because the runtime indexes
   *  shows by position in its parallel arrays. */
  renderNodeIndex: number
  /** Which paint axis on the node. */
  paintAxis: PaintAxis
  /** The kernel itself (wgsl + entryPoint + dispatch helpers). */
  kernel: ComputeKernel
  /** The field name(s) the kernel reads. Worker-side feature-data
   *  packer uses this to lay out the feat_data buffer with the
   *  matching stride + offsets. Subset of kernel.fieldOrder; lifted
   *  to the entry level so the scheduler doesn't have to peek into
   *  kernel metadata. */
  fieldOrder: readonly string[]
  /** Per-field alphabetised pattern list for match() kernels (empty
   *  for ternary / interpolate kernels). Lifted from
   *  kernel.categoryOrder so the runtime packer can do the
   *  string→ID conversion without re-walking the kernel struct. */
  categoryOrder: Record<string, readonly string[]>
}

/** Walk every RenderNode × paint axis in the Scene; produce one
 *  ComputePlanEntry per axis the router accepts and the lowering
 *  succeeds at. Unrouted (cpu / palette / inline) and unloweable
 *  shapes are silently skipped — the runtime's fragment path still
 *  handles them via the legacy paint-shape-resolve. */
export function planComputeKernels(scene: Scene): ComputePlanEntry[] {
  const out: ComputePlanEntry[] = []
  for (let i = 0; i < scene.renderNodes.length; i++) {
    const node = scene.renderNodes[i]!
    pushAxis(out, i, 'fill', node.fill)
    pushAxis(out, i, 'stroke-color', node.stroke.color)
  }
  return out
}

function pushAxis(
  out: ComputePlanEntry[],
  renderNodeIndex: number,
  paintAxis: PaintAxis,
  value: RenderNode['fill'],
): void {
  const route = routeColorValue(value)
  if (!routeIsCompute(route)) return

  // The router promised FEATURE-deps; now find a lowering that
  // produces a kernel. Two shapes are supported today:
  //
  //   1. ColorValue.kind === 'conditional'  → ternary kernel
  //   2. ColorValue.kind === 'data-driven' w/ match() AST → match kernel
  //
  // Anything else (nested expressions, ConditionalExpr ASTs, etc.)
  // means lowering returns null — we drop the axis from the plan
  // and the runtime falls back to inline-fragment emit. The router
  // signal being `compute-feature` is necessary but not sufficient.

  if (value.kind === 'conditional') {
    const spec = lowerConditionalColorToTernary(value)
    if (!spec) return
    const kernel = emitTernaryComputeKernel(spec)
    out.push({
      renderNodeIndex, paintAxis, kernel,
      fieldOrder: kernel.fieldOrder,
      categoryOrder: kernel.categoryOrder ?? {},
    })
    return
  }

  if (value.kind === 'data-driven') {
    const spec = lowerMatchColorToMatch(value.expr)
    if (!spec) return
    const kernel = emitMatchComputeKernel(spec)
    out.push({
      renderNodeIndex, paintAxis, kernel,
      fieldOrder: kernel.fieldOrder,
      categoryOrder: kernel.categoryOrder ?? {},
    })
    return
  }

  // Other FEATURE-dep shapes (data-driven non-match ASTs, future
  // composite axes) fall through. Future P4-6 can revisit.
}
