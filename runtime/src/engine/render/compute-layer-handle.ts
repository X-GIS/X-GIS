// ═══════════════════════════════════════════════════════════════════
// Per-layer compute lifecycle handle
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 4-5 final runtime composition piece before the actual
// renderer.ts integration. Glues every primitive shipped this
// session into a single object the renderer can instantiate once
// per layer that has compute paint:
//
//   - TileComputeResources       (per-axis (feat/out/count) trios)
//   - extendBindGroupLayoutEntriesForCompute  (layout descriptor)
//   - buildComputeBindGroupEntries           (per-tile bind entries)
//   - dispatcher.dispatchKernel              (per-frame GPU work)
//
// The renderer integration shrinks to:
//
//   if (variant.computeBindings) {
//     layer.compute = new ComputeLayerHandle(
//       dispatcher, variant, scenePlan, renderNodeIndex,
//     )
//     layer.compute.uploadFromProps(getProps, featureCount)
//   }
//
//   // pipeline layout build:
//   const entries = extendBindGroupLayoutEntriesForCompute(
//     variant, baseEntries, GPUShaderStage.FRAGMENT,
//   )
//
//   // bind group create per frame:
//   const computeEntries = layer.compute?.getBindGroupEntries() ?? []
//   const bindGroup = device.createBindGroup({
//     layout, entries: [...legacyEntries, ...computeEntries],
//   })
//
//   // per-frame dispatch:
//   layer.compute?.dispatch(encoder)
//
// What this module does NOT do:
//
//   - Touch the renderer. ComputeLayerHandle is opt-in — caller
//     constructs it only when variant.computeBindings is set.
//   - Pick bind-group slots. The variant carries the slots; the
//     handle just plumbs them through. Compiler's
//     `computePathBaseBinding` config decides the actual numbers.
//   - Cache layouts. Each handle owns its own resources; pipeline
//     layouts are cached at a higher level (renderer's shaderCache
//     keyed by variant.key, which already includes the compute
//     fingerprint).

import type { ComputePlanEntry, ShaderVariant } from '@xgis/compiler'
import { ComputeDispatcher } from '../gpu/compute'
import { TileComputeResources } from './tile-compute-resources'
import {
  buildComputeBindGroupEntries,
  type ComputeBindEntry,
} from './compute-bind-layout'
import type { FeaturePropertyBag } from './compute-feature-packer'

/** One layer's compute lifecycle. Construct once per addLayer when
 *  the variant has computeBindings; call uploadFromProps when
 *  feature data is ready; call dispatch + getBindGroupEntries
 *  per frame. */
export class ComputeLayerHandle {
  private dispatcher: ComputeDispatcher
  private variant: ShaderVariant
  private renderNodeIndex: number
  private resources: TileComputeResources

  constructor(
    dispatcher: ComputeDispatcher,
    variant: ShaderVariant,
    scenePlan: readonly ComputePlanEntry[] | undefined,
    renderNodeIndex: number,
  ) {
    this.dispatcher = dispatcher
    this.variant = variant
    this.renderNodeIndex = renderNodeIndex
    // Filter the scene plan to entries for THIS show. The variant's
    // computeBindings array tells us how many entries to expect; if
    // the filter produces a different count, the (compiler-emitted
    // variant) ↔ (runtime scene plan) drifted somewhere upstream —
    // surface it as a thrown error rather than silently mis-binding.
    const entries = (scenePlan ?? []).filter(e => e.renderNodeIndex === renderNodeIndex)
    const expected = variant.computeBindings?.length ?? 0
    if (entries.length !== expected) {
      throw new Error(
        `ComputeLayerHandle: plan entries (${entries.length}) don't match `
        + `variant.computeBindings (${expected}) for renderNodeIndex=${renderNodeIndex}`,
      )
    }
    this.resources = new TileComputeResources(dispatcher, entries)
  }

  /** Number of compute kernels this layer dispatches per frame. */
  get kernelCount(): number {
    return this.resources.entryCount
  }

  /** Pack feature properties through every per-axis kernel + upload
   *  to GPU. Idempotent on same featureCount; reallocates on grow. */
  uploadFromProps(
    getProps: (fid: number) => FeaturePropertyBag | null | undefined,
    featureCount: number,
  ): void {
    this.resources.uploadFromProps(getProps, featureCount)
  }

  /** Run every kernel onto the encoder before render passes. When a
   *  GPUTimer-shaped `timestampWritesProvider` is supplied, its
   *  `computeWrites()` is consulted per kernel — the first non-null
   *  return attaches timestampWrites to that kernel's compute pass
   *  so the 'compute' breakdown ring lands a sample for this frame. */
  dispatch(
    encoder: GPUCommandEncoder,
    timestampWritesProvider?: { computeWrites(): GPUComputePassTimestampWrites | null } | null,
  ): void {
    this.resources.dispatch(encoder, timestampWritesProvider)
  }

  /** Bind-group entries for the layer's per-tile bind group. Caller
   *  appends them after the legacy entries when creating the bind
   *  group whose layout was extended via
   *  `extendBindGroupLayoutEntriesForCompute`. Returns null when
   *  any output buffer is missing — caller should fall back to the
   *  legacy variant rather than partial-bind. */
  getBindGroupEntries(): ComputeBindEntry[] | null {
    return buildComputeBindGroupEntries(
      this.variant,
      this.renderNodeIndex,
      this.resources.getOutBuffer.bind(this.resources),
    )
  }

  /** Release every GPU buffer this layer's compute pass owned.
   *  Call from the renderer's layer-removal path so device memory
   *  doesn't leak when the style changes or the layer is hidden. */
  destroy(): void {
    this.resources.destroy()
  }
}
