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

/** One unique-kernel's GPU resources. Entries that share a kernel
 *  reference (compute-plan dedup, P4-6) share these buffers — the
 *  output is functionally identical, so we save 3 buffers + 1
 *  dispatch per shared kernel. */
interface KernelResources {
  /** Representative entry — any entry pointing at this kernel has
   *  the same fieldOrder + categoryOrder + featureStrideF32 (those
   *  are derived from the kernel emit, identical for shared kernels). */
  representative: ComputePlanEntry
  featBuffer: GPUBuffer
  outBuffer: GPUBuffer
  countBuffer: GPUBuffer
  /** How many features have been uploaded so far. Drives dispatch
   *  workgroup count; 0 means "skip this kernel this frame". */
  featureCount: number
  /** Dirty flag: true when feature data has been (re)uploaded but
   *  the dispatch hasn't run yet. match() kernels are deterministic
   *  — `out_color[fid]` is a pure function of `feat_data[fid]` —
   *  so re-dispatching every frame when the data hasn't changed is
   *  pure GPU waste. uploadFromProps sets this; dispatch clears it.
   *
   *  Effective at 60 fps over a typical 100-tile scene: ~6000 extra
   *  compute dispatches/sec without the flag → ~100 with (one per
   *  tile-upload, amortised over the tile's lifetime). */
  dirty: boolean
}

/** One plan-entry's binding metadata. Points to the SHARED
 *  KernelResources via the kernel object reference; the actual
 *  buffers live in the kernels map. */
interface EntryBinding {
  entry: ComputePlanEntry
  kernel: ComputeKernel
}

/** A tile's worth of compute-pass resources. One instance per tile
 *  per scene (per-scene reusability would require recreating
 *  resources on style change anyway, so the lifetime is tied to
 *  the tile, not the scene).
 *
 *  Kernel-level dedup: compute-plan emits the same ComputeKernel
 *  reference for entries whose WGSL fingerprints match (P4-6). This
 *  class follows suit — one (feat / out / count) buffer trio per
 *  UNIQUE kernel, indexed via `Map<ComputeKernel, KernelResources>`.
 *  Entries sharing a kernel share the buffers; `getOutBuffer` walks
 *  through the entry → kernel → resources chain to return the
 *  shared buffer. */
export class TileComputeResources {
  private dispatcher: ComputeDispatcher
  private bindings: EntryBinding[]
  private kernels: Map<ComputeKernel, KernelResources>

  constructor(dispatcher: ComputeDispatcher, plan: readonly ComputePlanEntry[]) {
    this.dispatcher = dispatcher
    this.bindings = plan.map((entry) => ({ entry, kernel: entry.kernel }))
    this.kernels = new Map()
    for (const entry of plan) {
      if (this.kernels.has(entry.kernel)) continue
      // Allocate the (feat / out / count) trio for this unique
      // kernel. Worst case (no features yet) goes through the
      // 16-byte stub inside createFeatDataBuffer.
      this.kernels.set(entry.kernel, {
        representative: entry,
        featBuffer: dispatcher.createFeatDataBuffer(
          entry.kernel.featureStrideF32,
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
        dirty: false,
      })
    }
  }

  /** Number of plan entries bound to this tile. Equals
   *  `plan.length` from construction; can exceed `uniqueKernelCount`
   *  when compute-plan deduped shared kernels. */
  get entryCount(): number {
    return this.bindings.length
  }

  /** Number of unique compute kernels backing the entries. Counts
   *  the (feat / out / count) trios actually allocated. */
  get uniqueKernelCount(): number {
    return this.kernels.size
  }

  /** Output buffer for the kernel that evaluates `paintAxis` on the
   *  show at `renderNodeIndex`. The future P4-5 fragment-shader
   *  flip uses this to read `out_color[fid]` for the matching
   *  paint axis. Returns null when no entry in the plan targets
   *  that coordinate. */
  getOutBuffer(renderNodeIndex: number, paintAxis: 'fill' | 'stroke-color'): GPUBuffer | null {
    for (const b of this.bindings) {
      if (b.entry.renderNodeIndex === renderNodeIndex && b.entry.paintAxis === paintAxis) {
        return this.kernels.get(b.kernel)?.outBuffer ?? null
      }
    }
    return null
  }

  /** Pack feature properties for every unique kernel on this tile
   *  and upload to GPU. Resizes the per-kernel feat / out buffers
   *  when featureCount exceeds the previous capacity. Idempotent —
   *  call once per tile decode; per-frame work is just dispatch().
   *
   *  Each unique kernel is packed independently because different
   *  kernels have different fieldOrder + categoryOrder. Entries
   *  sharing a kernel share the packed data — that's the win. */
  uploadFromProps(getProps: (fid: number) => FeaturePropertyBag | null | undefined, featureCount: number): void {
    for (const r of this.kernels.values()) {
      const entry = r.representative
      const data = packFeatureData({
        getProps,
        fieldOrder: entry.fieldOrder,
        categoryOrder: entry.categoryOrder,
        featureCount,
      })

      // Resize buffers if the feature count outgrew the previous
      // allocation. The new buffer absorbs the old one's role; the
      // old buffer's `destroy()` is called so we don't leak when
      // tile re-decode pumps a larger feature count.
      const needFeatBytes = Math.max(16, featureCount * Math.max(1, entry.kernel.featureStrideF32) * 4)
      const needOutBytes = Math.max(16, featureCount * 4)
      if (((r.featBuffer as unknown) as { size: number }).size < needFeatBytes) {
        r.featBuffer.destroy()
        r.featBuffer = this.dispatcher.createFeatDataBuffer(
          entry.kernel.featureStrideF32,
          featureCount,
          `tile-feat:${entry.kernel.entryPoint}`,
        )
      }
      if (((r.outBuffer as unknown) as { size: number }).size < needOutBytes) {
        r.outBuffer.destroy()
        r.outBuffer = this.dispatcher.createOutColorBuffer(
          featureCount,
          `tile-out:${entry.kernel.entryPoint}`,
        )
      }

      this.dispatcher.uploadFeatData(r.featBuffer, data)
      this.dispatcher.writeCount(r.countBuffer, featureCount)
      r.featureCount = featureCount
      // Mark the kernel as needing a dispatch — the new data hasn't
      // been processed by the compute pass yet.
      r.dirty = true
    }
  }

  /** Dispatch every UNIQUE kernel onto the supplied encoder. Each
   *  kernel produces one compute pass; shared kernels (multiple
   *  entries pointing at the same ComputeKernel reference) dispatch
   *  once — that's the runtime half of P4-6 dedup.
   *
   *  When a `timestampWritesProvider` is supplied (the GPUTimer), the
   *  FIRST kernel dispatched this frame attaches its timestampWrites
   *  to its compute pass — the provider returns non-null only once
   *  per frame (see GPUTimer.computeWrites). Multi-kernel scenes get
   *  the first kernel's time as a representative sample; single-kernel
   *  scenes (continent-match etc.) get full compute time. */
  dispatch(
    encoder: GPUCommandEncoder,
    timestampWritesProvider?: { computeWrites(): GPUComputePassTimestampWrites | null } | null,
  ): void {
    // Debug override — when set on globalThis, the dirty short-circuit is
    // bypassed so the compute pass dispatches every frame. Used by the
    // `_perf-compute-strategy.spec.ts` A/B benchmark to surface kernel
    // timing on a static scene whose output buffer would otherwise be
    // valid across frames. Production code never sets this.
    const forceEveryFrame = typeof globalThis !== 'undefined'
      && (globalThis as { __XGIS_FORCE_COMPUTE_DISPATCH?: boolean }).__XGIS_FORCE_COMPUTE_DISPATCH === true
    for (const r of this.kernels.values()) {
      // Skip when nothing's changed since the last dispatch — the
      // output buffer still holds the last frame's correct values
      // (match() kernels are deterministic per feature data). At
      // steady state (panning a populated viewport), this skips
      // 100% of compute dispatches.
      if (!forceEveryFrame && !r.dirty) continue
      const tw = timestampWritesProvider?.computeWrites() ?? null
      this.dispatcher.dispatchKernel(
        encoder,
        r.representative.kernel,
        r.featBuffer,
        r.outBuffer,
        r.countBuffer,
        r.featureCount,
        tw,
      )
      r.dirty = false
    }
  }

  /** Walk a callback over every entry's (kernel, outBuffer,
   *  renderNodeIndex, paintAxis). Entries sharing a kernel are
   *  reported separately with the SAME outBuffer reference — caller
   *  decides whether to dedup at the bind-group level. */
  forEachOutput(
    fn: (
      kernel: ComputeKernel,
      outBuffer: GPUBuffer,
      renderNodeIndex: number,
      paintAxis: 'fill' | 'stroke-color',
    ) => void,
  ): void {
    for (const b of this.bindings) {
      const r = this.kernels.get(b.kernel)
      if (!r) continue
      fn(b.kernel, r.outBuffer, b.entry.renderNodeIndex, b.entry.paintAxis)
    }
  }

  /** Release every GPU buffer this bundle owns. Call when the tile
   *  evicts from the visible set. After dispose, all methods are
   *  no-ops (the bindings + kernels collections are cleared so the
   *  references don't pin device memory). */
  destroy(): void {
    for (const r of this.kernels.values()) {
      r.featBuffer.destroy()
      r.outBuffer.destroy()
      r.countBuffer.destroy()
    }
    this.kernels.clear()
    this.bindings.length = 0
  }
}
