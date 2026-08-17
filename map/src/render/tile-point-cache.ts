// #1632 — the packed tile-point GPU buffers, keyed PER SHOW.
//
// `scene-renderers.ts` builds ONE `PointRenderer` per map, but
// `VectorTileRenderer.emitTilePointsRhi` runs once per point SHOW per frame and
// the #1581 leg-B dirty check lived in a single scalar slot on the renderer
// (`_lastTilePointPackKey` + the three buffer fields). With two point shows — a
// halo layer plus a pin layer, the shape of every shipped point demo — each
// show's `flushTilePointsRhi` overwrote the key the other had just stamped, so
// `canSkipTilePointRepack` missed EVERY frame forever and the memo did nothing.
// Correctness was never affected (a miss falls through to a full repack); the
// optimization simply never ran. One slot per show id fixes it.
//
// Extracted rather than grown in place because point-renderer.ts sits at its LOC
// ceiling — the same reason tile-point-pack-key.ts and tile-point-draw.ts were.

import type { RhiBuffer, RhiDevice } from '@xgis/engine'
import { type TilePointPackKey, tilePointPackKeyEqual } from './tile-point-pack-key'

/** One show's packed tile-point buffers plus what they were packed FROM. */
export interface TilePointCacheSlot {
  buffer: RhiBuffer
  indexBuffer: RhiBuffer
  featBuffer: RhiBuffer
  packKey: TilePointPackKey | null
  totalN: number
  variant: 0 | 1
}

export class TilePointCache {
  private readonly slots = new Map<string, TilePointCacheSlot>()
  /** Buffers retired because their slot was rebuilt or evicted. Destroyed at the
   *  START of the NEXT frame (`drainRetired`) so any in-flight queue.submit()
   *  that bound them via the per-frame bind group completes first. Mirrors the
   *  retiredUniformRings pattern in vector-tile-renderer.ts: the WebGPU spec
   *  keeps the GPU-side memory alive after destroy() for already-submitted work,
   *  but it's illegal to ENQUEUE new commands referencing a destroyed buffer.
   *  With multi-source layered demos (4 VTRs each emitting tile points per
   *  frame), the rapid destroy+recreate inside the flush hit "Buffer used in
   *  submit while destroyed" validation errors when the prior frame's command
   *  encoder still referenced the same bind group. */
  private readonly retired: RhiBuffer[] = []

  get(showId: string): TilePointCacheSlot | undefined {
    return this.slots.get(showId)
  }

  /** True when `showId`'s buffers were packed from an equal key — the caller can
   *  skip accumulation + repack and redraw straight from the slot. */
  canSkip(showId: string, key: TilePointPackKey): boolean {
    const slot = this.slots.get(showId)
    return slot !== undefined && tilePointPackKeyEqual(slot.packKey, key)
  }

  /** Install `showId`'s freshly packed buffers, retiring the ones they displace. */
  set(showId: string, slot: TilePointCacheSlot): void {
    this.retire(this.slots.get(showId))
    this.slots.set(showId, slot)
  }

  /** Drop every slot whose id starts with `prefix` — the VectorTileRenderer that
   *  owns those show ids was destroyed, so nothing will ever redraw them. Without
   *  this a setSourceData swap or a style edit leaks three GPU buffers per point
   *  show, and GPU bytes exert no JS GC pressure to reclaim them. */
  evictPrefix(prefix: string): void {
    for (const [id, slot] of this.slots) {
      if (!id.startsWith(prefix)) continue
      this.retire(slot)
      this.slots.delete(id)
    }
  }

  /** Destroy the retired buffers queued by earlier frames — safe by this point
   *  because the previous frame's queue.submit() has already returned (it's
   *  synchronous in JS) and the GPU keeps destroyed buffers' memory alive until
   *  that work completes. */
  drainRetired(rhi: RhiDevice): void {
    if (this.retired.length === 0) return
    for (const b of this.retired) rhi.destroyBuffer(b)
    this.retired.length = 0
  }

  private retire(slot: TilePointCacheSlot | undefined): void {
    if (!slot) return
    this.retired.push(slot.buffer, slot.indexBuffer, slot.featBuffer)
  }
}
