// Graphics manager — the `map.graphics` host DRAWING API façade (#797).
//
// Phase 0 surface: addImage / hasImage / removeImage (host sprite images).
// The CPU registry is DEVICE-FREE and map-lifetime; the GPU atlas mirror is
// per-run (re)attached after each initGPU and dropped on scene swap, while
// the registry survives so host images persist across a re-load.

import { HostImageRegistry } from '../sprite/host-image-registry'
import { HostSpriteAtlasGPU } from '../sprite/host-sprite-atlas-gpu'

export class GraphicsManager {
  private readonly registry = new HostImageRegistry()
  private atlas: HostSpriteAtlasGPU | null = null

  /**
   * Register a host image into the sprite atlas under `name`, so styles can
   * reference it by `icon-image` (Mapbox `map.addImage` parity).
   *
   * PHASE 0 LIMITATIONS — read before relying on this:
   *  - HOST-ONLY RENDERING: host images render ONLY when the map has NO
   *    `sprite` URL. If the style declares a `sprite`, the image is still
   *    RECORDED here (hasImage/removeImage work), but it will NOT render
   *    alongside the URL sprite atlas yet — URL/host coexistence is Phase 1.
   *  - NO EVICTION: `removeImage` drops the registry entry only; the texels
   *    already packed into the atlas page stay resident (dead texels), and a
   *    re-add under the same name is NOT re-packed. Compaction is a later
   *    phase.
   *  - BOUNDED PAGE: images are shelf-packed into a single fixed 1024×1024
   *    page; an image that no longer fits is warned and skipped (never
   *    corrupts the page).
   */
  addImage(name: string, image: ImageBitmap | ImageData): void {
    this.registry.addImage(name, image)
    this.atlas?.markDirty()
  }

  hasImage(name: string): boolean {
    return this.registry.hasImage(name)
  }

  removeImage(name: string): void {
    this.registry.removeImage(name)
  }

  // ── internal (map.ts only) ─────────────────────────────────────────────

  /** Attach a freshly-initialised GPU device — builds the per-run atlas
   *  mirror over the surviving registry. Called after each initGPU resolves
   *  in run()/runBinary(). */
  attachDevice(device: GPUDevice): void {
    this.atlas = new HostSpriteAtlasGPU(device, this.registry)
  }

  /** The per-run GPU atlas mirror, or null before attachDevice. */
  hostAtlas(): HostSpriteAtlasGPU | null {
    return this.atlas
  }

  /** True when at least one host image is registered. */
  hasAnyImage(): boolean {
    return this.registry.size > 0
  }

  /** Drop the per-run GPU atlas on a scene swap / destroy. The registry (host
   *  images) is KEPT so a re-load re-packs them into the new device's page. */
  destroyGpu(): void {
    this.atlas?.destroy()
    this.atlas = null
  }
}
