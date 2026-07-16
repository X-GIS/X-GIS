// Sprite atlas → WebGPU texture binding.
//
// Mirror of GlyphAtlasGPU but for the SpriteAtlasHost. One texture
// upload per atlas-loaded transition; subsequent renders just bind
// the cached texture + sampler. Single-page atlas only (sprite PNGs
// are typically 256×256 to 1024×1024 — comfortably inside texture
// limits, no paging needed).

import { SpriteAtlasHost } from './sprite-atlas-host'
import type { RhiDevice, RhiSampler, RhiTexture, RhiTextureView } from '@xgis/engine'

export class SpriteAtlasGPU {
  private readonly device: GPUDevice
  private readonly rhi: RhiDevice | null
  private readonly host: SpriteAtlasHost
  private rhiTexture: RhiTexture | null = null
  private _rhiView: RhiTextureView | null = null
  private _rhiSampler: RhiSampler | null = null
  /** Lazy — populated on first `ensure()` after the host transitions
   *  to 'loaded'. Null when the atlas hasn't been uploaded yet. */
  private texture: GPUTexture | null = null
  private _sampler: GPUSampler | null = null

  constructor(device: GPUDevice, host: SpriteAtlasHost, rhi: RhiDevice | null = null) {
    this.device = device
    this.rhi = rhi
    this.host = host
  }

  /** Native sampler, created LAZILY (#834 device retirement S6): its only
   *  consumers are the WebGPU icon branch — the webgl2 arm reads
   *  rhiSampler() — so construction must not touch the device. Linear
   *  filter so non-integer-scale icons (icon-size != 1) stay smooth;
   *  clamp-to-edge so atlas neighbours never bleed. */
  get sampler(): GPUSampler {
    return (this._sampler ??= this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      label: 'sprite-atlas-sampler',
    }))
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
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
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

  /** iter-183 — fill-pattern Stage 2 entry point. Returns a texture
   *  view for the loaded atlas, or null when the host hasn't
   *  finished. Idempotent — repeated calls reuse the same view per
   *  texture identity (texture only changes on `destroy` + re-load,
   *  rare). Caller (map.ts) pushes the view into MapRenderer +
   *  VectorTileRenderer via their setSpriteAtlas[View] setters. */
  getView(): GPUTextureView | null {
    const tex = this.ensure()
    if (!tex) return null
    if (this._cachedView && this._cachedViewTexture === tex) return this._cachedView
    this._cachedView = tex.createView()
    this._cachedViewTexture = tex
    return this._cachedView
  }
  private _cachedView: GPUTextureView | null = null
  private _cachedViewTexture: GPUTexture | null = null

  /** RHI atlas twin accessors (#834 M5 slice 4 — same naming as the host
   *  atlas twins' rhiView/rhiSampler). Upload goes through the slice-2
   *  copyExternalImage seam (WebGL2 texSubImage2D, no CPU readback). Null
   *  until the host loads, or when no rhi was injected (legacy ctor). */
  rhiView(): RhiTextureView | null {
    if (!this.rhi) return null
    if (this._rhiView) return this._rhiView
    if (this.host.getState().status !== 'loaded') return null
    const image = this.host.getImage()
    if (!image) return null
    // 'render' is REQUIRED alongside 'copy-dst' here: the upload below routes
    // through rhi.copyExternalImage, whose WebGPU mapping is
    // queue.copyExternalImageToTexture — the WebGPU spec requires that copy's
    // DESTINATION to carry RENDER_ATTACHMENT | COPY_DST (the browser may blit
    // via an internal render pass for colourspace/premultiply conversion). The
    // native ensure() twin above already carries RENDER_ATTACHMENT for exactly
    // this reason; WebGL2 ignores usage bits (rhi-webgl2 createTexture
    // allocates identically). Missing 'render' surfaced as a Dawn
    // APIInjectError ("Destination texture needs to have CopyDst and
    // RenderAttachment usage") the FIRST time this twin was built on a WebGPU
    // device — the #777 I-E background-pattern pass reads the backend-blind
    // rhiView()/rhiSampler() handles, unlike the icon path's native-vs-rhi
    // caller fork (render-loop.ts _resolveFillPatterns), so it exercised this
    // path on WebGPU where the M5 forced-WebGL2 icon slice never validated it.
    // (HostSpriteAtlasRhi keeps ['sample','copy-dst'] — its upload is
    // writeTexture, a BufferSource copy that needs no RENDER_ATTACHMENT.)
    this.rhiTexture = this.rhi.createTexture({
      width: image.width,
      height: image.height,
      format: 'rgba8unorm',
      usage: ['sample', 'copy-dst', 'render'],
      label: 'sprite-atlas',
    })
    this.rhi.copyExternalImage(this.rhiTexture, image as ImageBitmap, image.width, image.height)
    this._rhiView = this.rhi.createView(this.rhiTexture)
    return this._rhiView
  }

  rhiSampler(): RhiSampler | null {
    if (!this.rhi) return null
    return (this._rhiSampler ??= this.rhi.createSampler({
      mag: 'linear',
      min: 'linear',
      label: 'sprite-atlas-sampler-rhi',
    }))
  }

  destroy(): void {
    this.texture?.destroy()
    this.texture = null
    if (this.rhiTexture && this.rhi) this.rhi.destroyTexture(this.rhiTexture)
    this.rhiTexture = null
    this._rhiView = null
  }
}
