// Host sprite atlas — GPU mirror of the HostImageRegistry (#797 Phase 0).
//
// ONE mutable packed page texture, allocated EAGERLY and NEVER recreated.
// Host images pushed via `map.graphics.addImage` are region-uploaded into
// the existing page (copyExternalImageToTexture / writeTexture with an
// origin), so the icon bind group cached against this texture identity
// (IconRenderer) and the one-shot-pushed fill-pattern view stay valid with
// zero renderer changes. Recreating the texture on a later upload would
// silently invalidate that cached bind group — hence the never-recreate
// invariant in ensure().
//
// Per-run (dies with the GPUDevice on a scene swap); the DEVICE-FREE
// HostImageRegistry it mirrors survives so host images outlive the atlas.

import { xlog } from '@xgis/shared'
import type { SpriteInfo } from './sprite-atlas-host'
import type { HostImageRegistry } from './host-image-registry'
import type { IconAtlasGpu, SpriteMetadataSource } from './icon-stage'

/** Fixed single-page dimensions. rgba8unorm, matching SpriteAtlasGPU. */
const PAGE = 1024

/** ImageData carries a `.data` byte array; ImageBitmap does not. Structural
 *  probe avoids `instanceof ImageData`, whose global is absent in non-DOM
 *  (test) environments. */
function isImageData(source: ImageBitmap | ImageData): source is ImageData {
  return 'data' in source
}

export class HostSpriteAtlasGPU implements IconAtlasGpu, SpriteMetadataSource {
  private readonly device: GPUDevice
  private readonly registry: HostImageRegistry
  readonly sampler: GPUSampler

  /** The fixed page. Allocated lazily on first ensure() and then held for
   *  the atlas's life — NEVER recreated. */
  private texture: GPUTexture | null = null
  private _cachedView: GPUTextureView | null = null
  private _cachedViewTexture: GPUTexture | null = null

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

  constructor(device: GPUDevice, registry: HostImageRegistry) {
    this.device = device
    this.registry = registry
    // Sampler config copied verbatim from SpriteAtlasGPU (sprite-atlas-gpu.ts):
    // linear filtering so non-integer-scale icons stay smooth; clamp-to-edge so
    // atlas neighbours never bleed.
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      label: 'host-sprite-atlas-sampler',
    })
  }

  /** Eagerly allocate the fixed 1024² page. Idempotent — the texture is
   *  allocated ONCE and NEVER recreated. Subsequent uploads only
   *  region-copy into this same texture (see upload()), so any bind group /
   *  view cached against its identity stays valid. */
  ensure(): GPUTexture {
    if (this.texture) return this.texture
    this.texture = this.device.createTexture({
      size: { width: PAGE, height: PAGE },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
      label: 'host-sprite-atlas',
    })
    return this.texture
  }

  /** Texture view, cached per texture identity (mirrors SpriteAtlasGPU). The
   *  page identity never changes, so this is effectively allocated once. */
  getView(): GPUTextureView {
    const tex = this.ensure()
    if (this._cachedView && this._cachedViewTexture === tex) return this._cachedView
    this._cachedView = tex.createView()
    this._cachedViewTexture = tex
    return this._cachedView
  }

  size(): { width: number; height: number } {
    return { width: PAGE, height: PAGE }
  }

  /** Always 'loaded' — the page exists eagerly, so IconStage / fill-pattern
   *  consumers never wait on a fetch. */
  getState(): { status: 'loaded' } {
    return { status: 'loaded' }
  }

  /** Always-ready — no async fetch backs a host atlas. */
  whenReady(): Promise<void> {
    return Promise.resolve()
  }

  markDirty(): void {
    this.dirty = true
  }

  /** Sprite metadata lookup. Runs a lazy dirty-gated sync() first so a
   *  just-added image is packed + uploaded before its first lookup. */
  get(name: string): SpriteInfo | undefined {
    this.sync()
    return this.packed.get(name)
  }

  /** Pack + region-upload every registry entry not yet in the atlas. Cheap
   *  no-op when nothing changed (dirty flag). An image that cannot fit the
   *  page is warned + skipped (bounded honest failure) — never partially
   *  uploaded, never corrupting the page. */
  sync(): void {
    if (!this.dirty) return
    const texture = this.ensure()
    for (const [name, entry] of this.registry.entries()) {
      if (this.packed.has(name)) continue
      const pos = this.allocate(entry.w, entry.h)
      if (pos === null) {
        xlog.warn(
          `[X-GIS graphics] "${name}" (${entry.w}×${entry.h}) does not fit the ${PAGE}×${PAGE} sprite atlas page — image skipped`,
        )
        continue
      }
      this.upload(texture, entry.source, pos.x, pos.y, entry.w, entry.h)
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
    if (w > PAGE || h > PAGE) return null
    if (this.shelfX + w > PAGE) {
      // Current shelf can't take this width — open a new shelf below it.
      this.shelfY += this.shelfH
      this.shelfX = 0
      this.shelfH = 0
    }
    if (this.shelfY + h > PAGE) return null // page height exhausted
    const x = this.shelfX
    const y = this.shelfY
    this.shelfX += w
    if (h > this.shelfH) this.shelfH = h
    return { x, y }
  }

  /** Region-upload one image into the page at (x, y). ImageBitmap goes
   *  through copyExternalImageToTexture (matching SpriteAtlasGPU defaults);
   *  ImageData through queue.writeTexture. */
  private upload(
    texture: GPUTexture,
    source: ImageBitmap | ImageData,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    if (isImageData(source)) {
      this.device.queue.writeTexture(
        { texture, origin: { x, y, z: 0 } },
        source.data,
        { bytesPerRow: w * 4, rowsPerImage: h },
        { width: w, height: h },
      )
    } else {
      this.device.queue.copyExternalImageToTexture(
        { source },
        { texture, origin: { x, y } },
        { width: w, height: h },
      )
    }
  }

  destroy(): void {
    this.texture?.destroy()
    this.texture = null
    this._cachedView = null
    this._cachedViewTexture = null
    this.packed.clear()
    this.shelfX = 0
    this.shelfY = 0
    this.shelfH = 0
    this.dirty = true
  }
}
