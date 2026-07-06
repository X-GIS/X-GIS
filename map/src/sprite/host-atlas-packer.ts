// Host atlas packer — the SINGLE CPU authority for host-image atlas layout
// (#823). Extracted verbatim from HostSpriteAtlasGPU so its two GPU mirrors —
// the WebGPU HostSpriteAtlasGPU and the RHI-native HostSpriteAtlasRhi (the
// WebGL2 fallback) — pack every image at IDENTICAL atlas coordinates. Two
// copies of the shelf allocator would be the classic sibling-divergence bug
// (same image, different UV rect per backend); one packer makes coordinate
// parity hold by construction.
//
// Owns the registry diff (which images still need packing), the shelf
// allocation cursor, and the packed SpriteInfo metadata. The UPLOAD itself is
// backend-specific and injected per sync() call.

import { xlog } from '@xgis/shared'
import type { SpriteInfo } from './sprite-atlas-host'
import type { HostImageRegistry } from './host-image-registry'

/** Fixed single-page dimensions. rgba8unorm, matching SpriteAtlasGPU. */
export const HOST_ATLAS_PAGE = 1024

export class HostAtlasPacker {
  /** Atlas-space metadata for every packed image, keyed by name. */
  private readonly packed = new Map<string, SpriteInfo>()

  // Shelf allocator cursor (row-based packing over the fixed page).
  private shelfX = 0
  private shelfY = 0
  private shelfH = 0

  /** Set when the registry gains an image; gates sync() so the pack +
   *  upload only runs when there is new work. Starts true so the first
   *  lookup packs any images registered before attachDevice. */
  private dirty = true

  constructor(private readonly registry: HostImageRegistry) {}

  markDirty(): void {
    this.dirty = true
  }

  get(name: string): SpriteInfo | undefined {
    return this.packed.get(name)
  }

  /** Pack every registry entry not yet in the atlas, invoking `upload` for
   *  each placed image. Cheap no-op when nothing changed (dirty flag). An
   *  image that cannot fit the page is warned + skipped (bounded honest
   *  failure) — never partially uploaded, never corrupting the page. */
  sync(upload: (source: ImageBitmap | ImageData, x: number, y: number, w: number, h: number) => void): void {
    if (!this.dirty) return
    for (const [name, entry] of this.registry.entries()) {
      if (this.packed.has(name)) continue
      const pos = this.allocate(entry.w, entry.h)
      if (pos === null) {
        xlog.warn(
          `[X-GIS graphics] "${name}" (${entry.w}×${entry.h}) does not fit the ${HOST_ATLAS_PAGE}×${HOST_ATLAS_PAGE} sprite atlas page — image skipped`,
        )
        continue
      }
      upload(entry.source, pos.x, pos.y, entry.w, entry.h)
      this.packed.set(name, {
        name,
        x: pos.x,
        y: pos.y,
        width: entry.w,
        height: entry.h,
        pixelRatio: 1,
        sdf: false,
      })
    }
    this.dirty = false
  }

  /** Row-based (shelf) allocator over the fixed page. Returns the top-left
   *  atlas-pixel origin, or null when the image cannot fit the page (either
   *  larger than the page, or the remaining page height is exhausted). */
  private allocate(w: number, h: number): { x: number; y: number } | null {
    if (w > HOST_ATLAS_PAGE || h > HOST_ATLAS_PAGE) return null
    if (this.shelfX + w > HOST_ATLAS_PAGE) {
      // Current shelf can't take this width — open a new shelf below it.
      this.shelfY += this.shelfH
      this.shelfX = 0
      this.shelfH = 0
    }
    if (this.shelfY + h > HOST_ATLAS_PAGE) return null // page height exhausted
    const x = this.shelfX
    const y = this.shelfY
    this.shelfX += w
    if (h > this.shelfH) this.shelfH = h
    return { x, y }
  }

  /** Drop all packed metadata + reset the shelf cursor (atlas destroy). */
  reset(): void {
    this.packed.clear()
    this.shelfX = 0
    this.shelfY = 0
    this.shelfH = 0
    this.dirty = true
  }
}
