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
//   - Dedup ENTRIES. Two entries with the same kernel still occupy
//     two slots — the runtime decides whether to share output
//     buffers based on `kernel` reference equality (see below).
//
// Kernel reference dedup:
//
// Two entries whose emitted kernel WGSL + entryPoint AND data layout
// (fieldOrder / categoryOrder) are identical share the SAME
// `ComputeKernel` object (reference equality) — see kernelFingerprint
// for why the data layout is part of the key, not just the WGSL. This
// lets the runtime detect "same kernel, different bind site" by
// `entries[i].kernel === entries[j].kernel` without re-hashing the
// WGSL string. Common case: fill + stroke axes both reference the
// same `match(get(class), school, '#f00', _, '#000')` expression.
// Today each axis produces an entry, but they share one
// ComputeKernel → the runtime can collapse them to one dispatch +
// one output buffer with two bind group entries pointing at it.
//
// The dedup operates on the emitted WGSL + data-layout fingerprint,
// NOT the AST. This catches:
//   - Identical ASTs at different sites (the obvious case).
//   - Lowering-equivalent ASTs (e.g. arms in different declared
//     order but the kernel emitter sorts them alphabetically before
//     emitting code).
// And does NOT catch:
//   - ASTs that lower to different kernels (e.g. one match() with
//     a `_` default vs one without — the emitter produces distinct
//     default-color branches).
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
 *  handles them via the legacy paint-shape-resolve.
 *
 *  Kernels are deduplicated by (in priority order):
 *    1. **cseId** — Phase C.2 (iter 202). When `scene.cseAnnotation`
 *       is present (set by the `cse-annotate` pass that runs at the
 *       tail of `optimize()`), two `data-driven` ColorValues whose
 *       source `Expr` shares a `cseId` skip the lower + emit step
 *       entirely and reuse the cached `ComputeKernel`. Costless dedup
 *       relative to the existing fingerprint path — the canonical
 *       hash is computed once during `cse-annotate`, not per axis.
 *    2. **WGSL+entryPoint fingerprint** — pre-existing fallback. Two
 *       entries whose emitted kernel is byte-identical (regardless
 *       of source AST identity — e.g. AST-different but emit-equal)
 *       still share the same `ComputeKernel` reference. Covers
 *       conditional ColorValues that have no single Expr to key on,
 *       and any data-driven Expr that wasn't seen by `cse-annotate`
 *       (e.g. scenes built directly by tests, bypassing the pipeline). */
export function planComputeKernels(scene: Scene): ComputePlanEntry[] {
  const out: ComputePlanEntry[] = []
  const wgslCache = new Map<string, ComputeKernel>()
  // Phase C.2 — cseId-keyed cache. Populated incrementally as
  // pushAxis processes axes. The cseAnnotation may be undefined
  // (Scene built without running cse-annotate, e.g. direct
  // construction in tests); pushAxis handles the fallback.
  const cseCache = new Map<number, ComputeKernel>()
  const cseIdByExpr = scene.cseAnnotation?.cseIdByExpr
  for (let i = 0; i < scene.renderNodes.length; i++) {
    const node = scene.renderNodes[i]!
    pushAxis(out, wgslCache, cseCache, cseIdByExpr, i, 'fill', node.fill)
    pushAxis(out, wgslCache, cseCache, cseIdByExpr, i, 'stroke-color', node.stroke.color)
  }
  return out
}

/** Fingerprint a kernel for cache lookup. `entryPoint` + `wgsl` identify the
 *  COMPUTE; `fieldOrder` + `categoryOrder` identify WHICH feature data it reads.
 *  Both halves are load-bearing: the DSL-IR-emitted kernels are POSITIONAL
 *  (`feat_data[fid]`, no `v_<field>` name baked in), so two match()/interpolate
 *  kernels on DIFFERENT fields — or matches whose pattern→ID mapping differs while
 *  the colour-by-id WGSL coincides — can share byte-identical WGSL yet must stay
 *  DISTINCT (each entry packs a different field / string→ID table). Keying on the
 *  data layout too keeps that dedup correct; truly-identical kernels still share.
 *  The `\x1F` separator is a unit-separator control char — can't appear in legal
 *  WGSL or identifier strings. */
function kernelFingerprint(k: ComputeKernel): string {
  return [
    k.entryPoint,
    k.wgsl,
    k.fieldOrder.join(','),
    JSON.stringify(k.categoryOrder ?? {}),
  ].join('\x1F')
}

function shareOrCache(
  cache: Map<string, ComputeKernel>,
  kernel: ComputeKernel,
): ComputeKernel {
  const key = kernelFingerprint(kernel)
  const existing = cache.get(key)
  if (existing) return existing
  cache.set(key, kernel)
  return kernel
}

function pushAxis(
  out: ComputePlanEntry[],
  wgslCache: Map<string, ComputeKernel>,
  cseCache: Map<number, ComputeKernel>,
  cseIdByExpr: WeakMap<import('../parser/ast').Expr, number> | undefined,
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
    // Conditional values have no single Expr to key cseId on
    // (multiple branch conditions + fallback). Stay on the WGSL
    // fingerprint path. Future iter could hash a synthetic id from
    // each branch's `condition.ast` cseId but the benefit is small
    // — conditional ColorValues are rare in real-world styles.
    const spec = lowerConditionalColorToTernary(value)
    if (!spec) return
    const kernel = shareOrCache(wgslCache, emitTernaryComputeKernel(spec))
    out.push({
      renderNodeIndex, paintAxis, kernel,
      fieldOrder: kernel.fieldOrder,
      categoryOrder: kernel.categoryOrder ?? {},
    })
    return
  }

  if (value.kind === 'data-driven') {
    // Phase C.2 — cseId fast path. If `cse-annotate` ran AND this
    // Expr is in its WeakMap, two data-driven ColorValues sharing a
    // cseId emit the same kernel by construction (canonicalExpr
    // walks the same AST shape). Skip the lower + emit + WGSL hash
    // entirely.
    const cseId = cseIdByExpr?.get(value.expr.ast)
    if (cseId !== undefined) {
      const cached = cseCache.get(cseId)
      if (cached) {
        out.push({
          renderNodeIndex, paintAxis, kernel: cached,
          fieldOrder: cached.fieldOrder,
          categoryOrder: cached.categoryOrder ?? {},
        })
        return
      }
    }
    const spec = lowerMatchColorToMatch(value.expr)
    if (!spec) return
    const kernel = shareOrCache(wgslCache, emitMatchComputeKernel(spec))
    // Populate cseCache so subsequent axes sharing this cseId hit
    // the fast path. WGSL-fingerprint cache populated by
    // shareOrCache above remains the safety net for axes whose Expr
    // isn't in the cseAnnotation (Scene built outside `optimize()`).
    if (cseId !== undefined) cseCache.set(cseId, kernel)
    out.push({
      renderNodeIndex, paintAxis, kernel,
      fieldOrder: kernel.fieldOrder,
      categoryOrder: kernel.categoryOrder ?? {},
    })
    return
  }

  // Other FEATURE-dep shapes (data-driven non-match ASTs, future
  // composite axes) fall through.
}
