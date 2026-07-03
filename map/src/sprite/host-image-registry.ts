// Host image registry — CPU authority for images pushed via the host
// DRAWING API (`map.graphics.addImage`, #797 Phase 0).
//
// DEVICE-FREE and ctor-safe: constructed at map-lifetime before any GPU
// device exists, and survives a scene swap (run()/runBinary() re-entry)
// so host images outlive the per-run GPU atlas mirror
// (HostSpriteAtlasGPU). Retains the decoded source (ImageBitmap /
// ImageData) — Phase 1 fill-patterns need a CPU-readable source, so we do
// NOT discard it after the GPU upload.

import { xlog } from '@xgis/shared'

export interface HostImageEntry {
  /** The caller-supplied raster. Retained (not discarded) for Phase 1
   *  CPU-readback paths. */
  source: ImageBitmap | ImageData
  /** Pixel dimensions, normalised from the source at insert time. */
  w: number
  h: number
}

export class HostImageRegistry {
  private readonly images = new Map<string, HostImageEntry>()

  /** Register (or replace) a host image. Both ImageBitmap and ImageData
   *  expose `.width` / `.height`, so dimensions normalise uniformly.
   *  A blank name or an absent source is a caller error — warn + drop
   *  rather than store an unusable entry. */
  addImage(name: string, source: ImageBitmap | ImageData): void {
    if (name === '') {
      xlog.warn('[X-GIS graphics] addImage: empty name — image ignored')
      return
    }
    if (source == null) {
      xlog.warn(`[X-GIS graphics] addImage("${name}"): missing image source — ignored`)
      return
    }
    this.images.set(name, { source, w: source.width, h: source.height })
  }

  hasImage(name: string): boolean {
    return this.images.has(name)
  }

  /** Metadata drop only — no atlas eviction / compaction (Phase 0 leaves
   *  the packed texels dead, by design). */
  removeImage(name: string): void {
    this.images.delete(name)
  }

  entries(): IterableIterator<[string, HostImageEntry]> {
    return this.images.entries()
  }

  get(name: string): HostImageEntry | undefined {
    return this.images.get(name)
  }

  get size(): number {
    return this.images.size
  }
}
