// ═══ RetireQueue — deferred destroy for render-bound GPU resources (#2405) ═══
//
// A GPU resource that a submitted-but-not-yet-drained frame may still reference
// cannot be destroyed inline: WebGPU keeps a destroyed buffer's memory alive for
// work already submitted, but it is illegal to ENQUEUE commands referencing it,
// so a destroy that lands mid-frame surfaces as
// `[Buffer "…"] used in submit while destroyed` at that frame's submit.
//
// The fix every owner arrived at independently is the same: push the resource to
// a list, destroy it at the top of the NEXT frame, once `queue.submit()` has
// returned for the frame that could still have referenced it. Before this class
// that rule was hand-mirrored six times across four owners
// (`gpu-tile-store`'s three lists, `vector-drape-renderer._retiredBakes`,
// `TilePointCache.retired`, the uniform rings' `takeRetired`), each free to
// drift — `gpu-tile-store` alone carries a mirror OF a mirror, because #834 M5
// flipped the segment buffers to `RhiBuffer` and the raw list stayed for the
// rest. This is the single authority those collapse into.
//
// WHY TYPED PUSHES RATHER THAN ONE `retire(resource)`: the resources are
// genuinely heterogeneous — a buffer and a texture have different destroy calls
// — and the call site always knows statically which it holds. Typed methods keep
// the cost identical to the array push each owner does today (no per-retire
// closure, no discriminant object on an eviction path that can retire many
// resources in one frame) without pretending the two are one type.
//
// WHAT THIS DELIBERATELY DOES NOT HOLD: raw `GPUBuffer`. `gpu-tile-store`'s
// `_retiredTileBuffers` is still a raw list because `TileGpuRecord.featureDataBuffer`
// is typed `GPUBuffer | null`, and the #991 raw-WebGPU ratchet exists to push
// exactly those tokens OUT of map/src and through this package's RHI — importing
// them INTO the neutral layer would invert that. Flipping that field to
// `RhiBuffer`, the way its segment-buffer siblings already were, is what folds
// the last list in; it is a typed-field change across the feature-data path and
// belongs in its own increment.
//
// THE DRAIN POINT IS THE CALLER'S, AND IT MATTERS. This class defers; it does not
// choose when the safe window is. A drain on a frame boundary (after the prior
// submit returned) may destroy — that is what every caller here does. A drain
// that can run MID-FRAME — a teardown triggered by a source swap rather than by
// the frame loop — may not, which is why `VectorTileRenderer` drops its retired
// ring buffers' refs rather than destroying them (`UniformRing`'s own header
// documents both policies as the caller's choice). A caller retiring outside a
// frame boundary must hand the resource here and let the next boundary drain it,
// never destroy at the retire site.

import type { RhiBuffer, RhiDevice, RhiTexture } from '@xgis/rhi'

export class RetireQueue {
  private buffers: RhiBuffer[] = []
  private textures: RhiTexture[] = []

  /** Queue a buffer for destruction at the next drain. Null/undefined is a
   *  no-op so callers can push an optional field without a guard — every
   *  current owner retires from a record whose buffers are nullable. */
  retireBuffer(b: RhiBuffer | null | undefined): void {
    if (b) this.buffers.push(b)
  }

  /** Queue a texture for destruction at the next drain. */
  retireTexture(t: RhiTexture | null | undefined): void {
    if (t) this.textures.push(t)
  }

  /** Resources awaiting destruction. Diagnostic — the drain is unconditional,
   *  so nothing production reads this to decide whether to run. */
  get size(): number {
    return this.buffers.length + this.textures.length
  }

  /** Destroy everything retired since the last drain, and empty the queue.
   *  Returns the number destroyed (the tests assert on it; production ignores it).
   *
   *  MUST be called from a point where the frame that could still reference these
   *  has submitted — see the header. Idempotent: a second call with nothing
   *  retired in between destroys nothing, so a caller that drains both per-frame
   *  and at teardown cannot double-destroy. */
  drain(rhi: RhiDevice): number {
    const n = this.buffers.length + this.textures.length
    if (n === 0) return 0
    for (const b of this.buffers) rhi.destroyBuffer(b)
    for (const t of this.textures) rhi.destroyTexture(t)
    this.buffers.length = 0
    this.textures.length = 0
    return n
  }
}
