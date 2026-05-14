// ═══════════════════════════════════════════════════════════════════
// Per-tile compute pass resources
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 4 final runtime composition piece. Bundles the GPU
// buffers + dispatch wiring for ONE tile's worth of compute kernel
// evaluation. The caller (vector-tile-renderer) drives the lifecycle:
//
//   1. Compile time:  build one TileComputeResources per visible
//      tile using the scene's ComputePlanEntry[].
//   2. Tile decode:   pack feature properties via uploadFromProps()
//      so each kernel's feat_data buffer is ready.
//   3. Per frame:     call dispatch(encoder) before render passes
//      to run every kernel; the output color buffers are bound to
//      the fragment shader as storage textures.
//   4. Disposal:      destroy() releases all GPU buffers.
//
// What this module does NOT do:
//
//   - Bind output buffers to fragment shaders. The fragment-shader
//     side flip (P4-5) is the next plan piece; until then the
//     output buffers are dispatched-to but unread.
//   - Decide tile lifecycle. The caller knows which tiles are
//     visible and which can be evicted.
//   - Multi-tile batching. Each tile gets its own bundle today;
//     P4-6 (multi-kernel composition) can fold tiles into a single
//     dispatch later if profiling shows the per-tile overhead.

import type { ComputeKernel, ComputePlanEntry } from '@xgis/compiler'
import { ComputeDispatcher } from '../gpu/compute'
import { packFeatureData, type FeaturePropertyBag } from './compute-feature-packer'

/** One plan-entry's GPU resources, kept together so dispatch() can
 *  walk them in plan order. */
interface PerEntryResources {
  entry: ComputePlanEntry
  featBuffer: GPUBuffer
  outBuffer: GPUBuffer
  countBuffer: GPUBuffer
  /** How many features have been uploaded so far. Drives dispatch
   *  workgroup count; 0 means "skip this entry this frame". */
  featureCount: number
}

/** A tile's worth of compute-pass resources. One instance per tile
 *  per scene (per-scene reusability would require recreating
 *  resources on style change anyway, so the lifetime is tied to
 *  the tile, not the scene). */
export class TileComputeResources {
  private dispatcher: ComputeDispatcher
  private entries: PerEntryResources[]

  constructor(dispatcher: ComputeDispatcher, plan: readonly ComputePlanEntry[]) {
    this.dispatcher = dispatcher
    this.entries = plan.map((entry) => ({
      entry,
      featBuffer: dispatcher.createFeatDataBuffer(
        entry.kernel.featureStrideF32,
        // Allocate to a reasonable starting capacity; the upload
        // path reallocates when feature count exceeds the buffer.
        // Worst case (no features yet) goes through the 16-byte
        // stub inside createFeatDataBuffer.
        0,
        `tile-feat:${entry.kernel.entryPoint}`,
      ),
      outBuffer: dispatcher.createOutColorBuffer(
        0,
        `tile-out:${entry.kernel.entryPoint}`,
      ),
      countBuffer: dispatcher.createCountBuffer(
        `tile-count:${entry.kernel.entryPoint}`,
      ),
      featureCount: 0,
    }))
  }

  /** Number of plan entries bound to this tile. Equals
   *  `plan.length` from construction. */
  get entryCount(): number {
    return this.entries.length
  }

  /** Output buffer for the kernel that evaluates `paintAxis` on the
   *  show at `renderNodeIndex`. The future P4-5 fragment-shader
   *  flip uses this to read `out_color[fid]` for the matching
   *  paint axis. Returns null when no entry in the plan targets
   *  that coordinate. */
  getOutBuffer(renderNodeIndex: number, paintAxis: 'fill' | 'stroke-color'): GPUBuffer | null {
    for (const e of this.entries) {
      if (e.entry.renderNodeIndex === renderNodeIndex && e.entry.paintAxis === paintAxis) {
        return e.outBuffer
      }
    }
    return null
  }

  /** Pack feature properties for every entry on this tile and
   *  upload to GPU. Resizes the per-entry feat / out buffers when
   *  featureCount exceeds the previous capacity. Idempotent — call
   *  once per tile decode; per-frame work is just dispatch(). */
  uploadFromProps(getProps: (fid: number) => FeaturePropertyBag | null | undefined, featureCount: number): void {
    for (const e of this.entries) {
      // Each entry's packer has its own fieldOrder + categoryOrder
      // (different kernels read different fields), so the typed
      // arrays don't share. The packer skips fields with 0-length
      // category maps gracefully.
      const data = packFeatureData({
        getProps,
        fieldOrder: e.entry.fieldOrder,
        categoryOrder: e.entry.categoryOrder,
        featureCount,
      })

      // Resize buffers if the feature count outgrew the previous
      // allocation. The new buffer absorbs the old one's role; the
      // old buffer's `destroy()` is called so we don't leak when
      // tile re-decode pumps a larger feature count.
      const needFeatBytes = Math.max(16, featureCount * Math.max(1, e.entry.kernel.featureStrideF32) * 4)
      const needOutBytes = Math.max(16, featureCount * 4)
      if (((e.featBuffer as unknown) as { size: number }).size < needFeatBytes) {
        e.featBuffer.destroy()
        e.featBuffer = this.dispatcher.createFeatDataBuffer(
          e.entry.kernel.featureStrideF32,
          featureCount,
          `tile-feat:${e.entry.kernel.entryPoint}`,
        )
      }
      if (((e.outBuffer as unknown) as { size: number }).size < needOutBytes) {
        e.outBuffer.destroy()
        e.outBuffer = this.dispatcher.createOutColorBuffer(
          featureCount,
          `tile-out:${e.entry.kernel.entryPoint}`,
        )
      }

      this.dispatcher.uploadFeatData(e.featBuffer, data)
      this.dispatcher.writeCount(e.countBuffer, featureCount)
      e.featureCount = featureCount
    }
  }

  /** Dispatch every kernel in plan order onto the supplied encoder.
   *  Each entry produces one compute pass — the WebGPU spec allows
   *  multiple compute passes per encoder, so we don't try to fuse
   *  them. Plan order is the source of truth for output buffer
   *  binding lookups (no other coupling between entries). */
  dispatch(encoder: GPUCommandEncoder): void {
    for (const e of this.entries) {
      this.dispatcher.dispatchKernel(
        encoder,
        e.entry.kernel,
        e.featBuffer,
        e.outBuffer,
        e.countBuffer,
        e.featureCount,
      )
    }
  }

  /** Walk a callback over every entry's kernel + outBuffer pair.
   *  Used by the fragment-side bind-group setup (P4-5) to attach
   *  each output buffer to the right show's paint slot. */
  forEachOutput(
    fn: (
      kernel: ComputeKernel,
      outBuffer: GPUBuffer,
      renderNodeIndex: number,
      paintAxis: 'fill' | 'stroke-color',
    ) => void,
  ): void {
    for (const e of this.entries) {
      fn(e.entry.kernel, e.outBuffer, e.entry.renderNodeIndex, e.entry.paintAxis)
    }
  }

  /** Release every GPU buffer this bundle owns. Call when the tile
   *  evicts from the visible set. After dispose, all methods are
   *  no-ops (the entries array is cleared to keep the references
   *  from holding device memory alive). */
  destroy(): void {
    for (const e of this.entries) {
      e.featBuffer.destroy()
      e.outBuffer.destroy()
      e.countBuffer.destroy()
    }
    this.entries.length = 0
  }
}
