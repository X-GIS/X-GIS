// ═══════════════════════════════════════════════════════════════════
// BundleCache — Phase RB.B foundation (iter-212)
// ═══════════════════════════════════════════════════════════════════
//
// Caches GPURenderBundle objects so per-show / per-renderer encode
// runs ONCE (or once per invalidation). On subsequent frames, the
// render pass executes the cached bundle via `executeBundles([b])`
// — a SINGLE native API call replays every draw inside the bundle.
//
// CPU savings (steady-state):
//   - Pre-bundle: N tiles × M layers × (setBindGroup + setVertexBuffer
//     + setIndexBuffer + drawIndexed) WebGPU calls per frame
//   - Post-bundle: 1 `executeBundles([b])` call per cached bundle
//   - At z=14 OFM Bright Seoul: 270 calls → 1 (RB.C baseline iter-211)
//
// Pre-requisites this iter relies on:
//   - Phase 6a.2/6a.3/6a.4 (iter-208/209/210): vertex/index/z buffers
//     are SHARED arenas. The bundle's `setVertexBuffer` records a
//     BUFFER REFERENCE; with per-tile buffer refs (pre-Phase-6a), the
//     bundle would need re-encoding on every tile upload. Shared
//     arenas keep the buffer ref stable across tile churn.
//
// Bundle vs pass distinction (WebGPU spec):
//
//   GPURenderBundleEncoder can issue:
//     ✓ setPipeline
//     ✓ setBindGroup (with dynamic offsets)
//     ✓ setVertexBuffer / setIndexBuffer
//     ✓ draw / drawIndexed / drawIndirect / drawIndexedIndirect
//
//   GPURenderBundleEncoder CANNOT issue:
//     ✗ setStencilReference   (pass-only — must wrap bundle externally)
//     ✗ setBlendConstant
//     ✗ setViewport / setScissorRect
//     ✗ beginOcclusionQuery / endOcclusionQuery
//     ✗ executeBundles (no nesting)
//
//   Callers split their draw sequence such that any stencil/blend/
//   viewport state-changes happen OUTSIDE the bundle.
//
// Invalidation:
//
//   The cache key is opaque (string). Callers compose it from
//   anything that, if changed, requires re-encoding. Typical keys:
//     - "bg" — single bundle for background pass
//     - "vt:<showName>:<phaseKey>" — per-show per-phase bundle
//
//   When the underlying scene changes (tile add/remove, variant
//   pipeline rebuild, style change), the caller invalidates the
//   matching key — next frame re-encodes.
//
//   Uniform DATA updates do NOT require invalidation — bundle
//   records the bind group REFERENCE; the GPU sees fresh buffer
//   contents from writeBuffer through the same bind group. Only
//   bind-group reassignment (different GPUBindGroup object)
//   invalidates the bundle.

/** Descriptor for encoding a new bundle. Matches a subset of the
 *  WebGPU `GPURenderBundleEncoderDescriptor` — color/depth/stencil
 *  formats must match the destination render pass's attachments. */
export interface BundleEncodeDescriptor {
  /** Color attachment formats (must match the dest pass). */
  colorFormats: readonly (GPUTextureFormat | null)[]
  /** Depth/stencil attachment format. Null when the dest pass has
   *  no depth-stencil attachment. */
  depthStencilFormat?: GPUTextureFormat
  /** MSAA sample count of the dest pass (must match). */
  sampleCount?: number
  /** Whether the dest pass is depth-read-only / stencil-read-only.
   *  Bundle must declare the SAME state. */
  depthReadOnly?: boolean
  stencilReadOnly?: boolean
  /** Optional label for WebGPU validator messages. */
  label?: string
}

/** Function that records draw commands into the bundle encoder. */
export type BundleEncodeFn = (encoder: GPURenderBundleEncoder) => void

interface CachedBundle {
  bundle: GPURenderBundle
  /** Monotonic counter for diagnostic / LRU. Bumped on every
   *  getOrEncode call that returns this entry (cache hit). */
  lastUsed: number
}

export class BundleCache {
  private device: GPUDevice
  private bundles = new Map<string, CachedBundle>()
  private callCounter = 0
  /** Cache hit / miss counters (diagnostic). */
  private _hits = 0
  private _misses = 0
  /** iter-227 — Soft cap on cached bundle count. Without a cap the
   *  cache grows unbounded across long pan/zoom sessions: every
   *  distinct (slice, phase, tile-set, world-offset, upload-epoch,
   *  rebuild-epoch, pickEnabled, sampleCount, pipeline labels)
   *  tuple is a new entry. iter-226 raised the steady-state hit
   *  rate to 97.6 %, which is excellent but means the cache rarely
   *  GCs by natural turnover. 1024 entries × (one GPURenderBundle
   *  command list + bind-group refs each) keeps the cache footprint
   *  small while covering all common multi-zoom-level scenes.
   *  Configurable via constructor for tests + future tuning. */
  private maxEntries: number
  /** iter-227 — Lifetime eviction counter (diagnostic). Exposed
   *  through getStats() so users can see whether the cap is firing
   *  during the session. */
  private _evictions = 0

  constructor(device: GPUDevice, maxEntries: number = 1024) {
    this.device = device
    this.maxEntries = maxEntries
  }

  /** Get the bundle for `key`; encode + cache on miss.
   *
   *  The `desc` and `encodeFn` are consulted ONLY on miss. Callers
   *  that change `desc` (e.g. attachment format change) MUST also
   *  call `invalidate(key)` so the new descriptor takes effect. */
  getOrEncode(
    key: string,
    desc: BundleEncodeDescriptor,
    encodeFn: BundleEncodeFn,
  ): GPURenderBundle {
    this.callCounter++
    const existing = this.bundles.get(key)
    if (existing) {
      existing.lastUsed = this.callCounter
      this._hits++
      return existing.bundle
    }
    // Cache miss: encode a fresh bundle. WebGPU spec requires the
    // descriptor's formats to match the encompassing render pass.
    const encoder = this.device.createRenderBundleEncoder({
      colorFormats: desc.colorFormats,
      depthStencilFormat: desc.depthStencilFormat,
      sampleCount: desc.sampleCount,
      depthReadOnly: desc.depthReadOnly,
      stencilReadOnly: desc.stencilReadOnly,
      label: desc.label,
    })
    encodeFn(encoder)
    const bundle = encoder.finish({ label: desc.label })
    // iter-227 — enforce cap BEFORE insertion so post-insert size
    // stays at `maxEntries`. Eviction picks the entry with the
    // lowest `lastUsed` (LRU). Scan cost = O(N); only paid on
    // miss + cap-hit, which is rare at the 97.6 % steady-state
    // hit rate.
    if (this.bundles.size >= this.maxEntries) this.evictLRU()
    this.bundles.set(key, { bundle, lastUsed: this.callCounter })
    this._misses++
    return bundle
  }

  /** iter-227 — Drop the entry with the lowest `lastUsed` counter.
   *  Called from `getOrEncode` on a miss when the cap is hit.
   *  Map.size never exceeds `maxEntries` post-call. */
  private evictLRU(): void {
    let oldestKey: string | null = null
    let oldestUsed = Infinity
    for (const [k, v] of this.bundles) {
      if (v.lastUsed < oldestUsed) {
        oldestUsed = v.lastUsed
        oldestKey = k
      }
    }
    if (oldestKey !== null) {
      this.bundles.delete(oldestKey)
      this._evictions++
    }
  }

  /** Drop a specific cache entry. Next `getOrEncode` for the same
   *  key re-encodes. Use when the scene changed in a way that
   *  affects this bundle (tile add/remove for VT shows, pipeline
   *  rebuild, source switch). */
  invalidate(key: string): void {
    this.bundles.delete(key)
  }

  /** Drop every cached entry. Use on tear-down / source replacement /
   *  pipeline-rebuild-all events. */
  invalidateAll(): void {
    this.bundles.clear()
  }

  /** Diagnostic snapshot. iter-227 adds `evictions` (lifetime count
   *  of LRU drops from the cap) + `maxEntries` (the configured cap)
   *  so users can see whether the cap is firing during the session. */
  getStats(): {
    size: number
    hits: number
    misses: number
    hitRate: number
    evictions: number
    maxEntries: number
  } {
    const total = this._hits + this._misses
    return {
      size: this.bundles.size,
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? this._hits / total : 0,
      evictions: this._evictions,
      maxEntries: this.maxEntries,
    }
  }
}
