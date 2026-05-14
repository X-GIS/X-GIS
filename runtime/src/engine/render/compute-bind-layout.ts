// ═══════════════════════════════════════════════════════════════════
// Compute-aware bind group layout extension
// ═══════════════════════════════════════════════════════════════════
//
// Pure runtime factory for the upcoming P4-5i+ pipeline-layout
// integration. Takes the legacy bind-group layout's entries (the
// ones the existing fragment shader uses — uniforms, feature data
// buffer, palette atlas, etc.) and appends one read-only-storage
// entry per binding in the merged variant's `computeBindings`.
//
// The entries are pure data — `device.createBindGroupLayout` is a
// one-line call away. Splitting the descriptor build from the
// device-call lets us:
//
//   - Unit-test the layout shape without a GPUDevice.
//   - Compare two layouts byte-for-byte for cache deduplication
//     (the legacy variant cache keys by `variant.key`, which
//     already includes the compute fingerprint, so two merged
//     variants with the same fingerprint produce the same layout
//     descriptor and can share the GPUBindGroupLayout instance).
//   - Reuse from BOTH renderer.ts (GeoJSON) and vector-tile-
//     renderer.ts (MVT) when each grows its own compute path
//     wire-up — they share this descriptor shape.
//
// What this module does NOT do:
//
//   - Create the GPUBindGroupLayout. Caller passes the descriptor
//     to `device.createBindGroupLayout` itself; this keeps the
//     module pure and Node-testable.
//   - Decide visibility flags. Compute outputs are FRAGMENT-only
//     reads (vertex shaders don't paint), so the helper hardcodes
//     `GPUShaderStage.FRAGMENT` — passed as a parameter so tests
//     can use a stub value when WebGPU globals aren't around.
//   - Validate slot collisions. The compiler picks bindings starting
//     at `computePathBaseBinding`; the caller chose a value that
//     avoids the legacy slots. If they collide, WebGPU validation
//     fires at layout-create time — easier to diagnose than at
//     runtime-bind.

import type { ShaderVariant } from '@xgis/compiler'

/** Append compute output bindings to a legacy layout descriptor.
 *  Returns a new array — the input `legacyEntries` is not mutated.
 *  When `variant.computeBindings` is absent or empty, returns
 *  `legacyEntries` by reference (no allocation). */
export function extendBindGroupLayoutEntriesForCompute(
  variant: ShaderVariant,
  legacyEntries: readonly GPUBindGroupLayoutEntry[],
  fragmentVisibilityBit: number,
): readonly GPUBindGroupLayoutEntry[] {
  const bindings = variant.computeBindings
  if (!bindings || bindings.length === 0) return legacyEntries

  const extended: GPUBindGroupLayoutEntry[] = [...legacyEntries]
  for (const b of bindings) {
    extended.push({
      binding: b.binding,
      visibility: fragmentVisibilityBit,
      buffer: { type: 'read-only-storage' as const },
    })
  }
  return extended
}

/** Build the GPUBindGroupEntry array the runtime passes to
 *  `device.createBindGroup` when constructing the per-tile bind
 *  group. `getOutBuffer` is the lookup function (typically
 *  `TileComputeResources.getOutBuffer.bind(resources)`) that maps
 *  (renderNodeIndex, paintAxis) to the GPUBuffer. The
 *  `renderNodeIndex` is passed in once per call because a single
 *  variant binds to one show's resources at a time.
 *
 *  Returns null if any compute-output buffer is missing — the
 *  runtime should log + fall back rather than partial-bind. */
export interface ComputeBindEntry {
  binding: number
  resource: { buffer: GPUBuffer }
}

export function buildComputeBindGroupEntries(
  variant: ShaderVariant,
  renderNodeIndex: number,
  getOutBuffer: (idx: number, axis: 'fill' | 'stroke-color') => GPUBuffer | null,
): ComputeBindEntry[] | null {
  const bindings = variant.computeBindings
  if (!bindings || bindings.length === 0) return []

  const out: ComputeBindEntry[] = []
  for (const b of bindings) {
    const buf = getOutBuffer(renderNodeIndex, b.paintAxis)
    if (!buf) return null
    out.push({ binding: b.binding, resource: { buffer: buf } })
  }
  return out
}
