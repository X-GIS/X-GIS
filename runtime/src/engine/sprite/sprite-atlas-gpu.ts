// Sprite atlas → WebGPU texture binding.
//
// Mirror of GlyphAtlasGPU but for the SpriteAtlasHost. One texture
// upload per atlas-loaded transition; subsequent renders just bind
// the cached texture + sampler. Single-page atlas only (sprite PNGs
// are typically 256×256 to 1024×1024 — comfortably inside texture
// limits, no paging needed).

import { SpriteAtlasHost } from './sprite-atlas-host'

export class SpriteAtlasGPU {
  private readonly device: GPUDevice
  private readonly host: SpriteAtlasHost
  /** Lazy — populated on first `ensure()` after the host transitions
   *  to 'loaded'. Null when the atlas hasn't been uploaded yet. */
  private texture: GPUTexture | null = null
  readonly sampler: GPUSampler

  constructor(device: GPUDevice, host: SpriteAtlasHost) {
    this.device = device
    this.host = host
    // Linear filter so non-integer-scale icons (icon-size != 1) stay
    // smooth; clamp-to-edge so atlas neighbours never bleed.
    this.sampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
      label: 'sprite-atlas-sampler',
    })
  }

  /** Returns the cached texture once the host has loaded the atlas.
   *  Idempotent — first call uploads the raster, subsequent calls
   *  return the same handle. Null when host isn't ready yet. */
  ensure(): GPUTexture | null {
    if (this.texture) return this.texture
    if (this.host.getState().status !== 'loaded') return null
    const image = this.host.getImage()
    if (!image) return null

    const w = image.width
    const h = image.height
    this.texture = this.device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      label: 'sprite-atlas',
    })
    // copyExternalImageToTexture handles both ImageBitmap and
    // HTMLImageElement on the WebGPU side.
    this.device.queue.copyExternalImageToTexture(
      { source: image as ImageBitmap },
      { texture: this.texture },
      { width: w, height: h },
    )
    return this.texture
  }

  /** Atlas image dimensions in pixels. Returns (0, 0) when not loaded. */
  size(): { width: number; height: number } {
    const img = this.host.getImage()
    return img ? { width: img.width, height: img.height } : { width: 0, height: 0 }
  }

  destroy(): void {
    this.texture?.destroy()
    this.texture = null
  }
}
