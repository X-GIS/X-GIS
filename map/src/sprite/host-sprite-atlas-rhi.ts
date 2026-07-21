// Host sprite atlas — RHI-native mirror of the HostImageRegistry (#823).
//
// The WebGL2-fallback twin of HostSpriteAtlasGPU: the retained-icon draper
// needs a REAL atlas texture on the WebGL2 backend, where `ctx.device` is a
// no-op Proxy stub (gpu.ts initGPUForcedWebGL2) and every GPUDevice call the
// WebGPU atlas makes would silently do nothing. This class builds the page
// through the backend-blind RhiDevice instead, so it works on ANY RHI backend
// — GraphicsManager picks it when `rhi.backend === 'webgl2'`.
//
// The atlas LAYOUT (shelf packing + SpriteInfo metadata) is the shared
// HostAtlasPacker — the SAME single authority HostSpriteAtlasGPU packs
// through, so both backends place every image at identical atlas coordinates
// by construction (the UV rects the retained-icon packer bakes are
// backend-portable). This class owns only the RHI resources + region upload.
//
// Same never-recreate page invariant as the WebGPU atlas: the texture is
// allocated once, region-uploaded forever, so the batch bind group cached
// against its identity stays valid. Per-run (dies on a scene swap); the
// DEVICE-FREE HostImageRegistry survives.

import { xlog } from '@xgis/shared'
import type { RhiDevice, RhiSampler, RhiTexture, RhiTextureView } from '@xgis/engine'
import type { SpriteInfo } from './sprite-atlas-host'
import type { HostImageRegistry } from './host-image-registry'
import { HostAtlasPacker, HOST_ATLAS_PAGE } from './host-atlas-packer'

/** ImageData carries a `.data` byte array; ImageBitmap does not. Structural
 *  probe avoids `instanceof ImageData`, whose global is absent in non-DOM
 *  (test) environments. */
function isImageData(source: ImageBitmap | ImageData): source is ImageData {
  return 'data' in source
}

/** Decode an ImageBitmap to raw RGBA bytes via a 2D canvas. The RHI
 *  writeTexture seam is BufferSource-only (no GPU-side external-image copy
 *  like WebGPU's copyExternalImageToTexture), so the bitmap is rasterised
 *  once at pack time. Returns null (warn + skip upstream) when no 2D canvas
 *  is available — bounded honest failure, never a corrupt page. */
function bitmapToImageData(source: ImageBitmap, w: number, h: number): ImageData | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  const ctx2d = new OffscreenCanvas(w, h).getContext('2d')
  if (!ctx2d) return null
  ctx2d.drawImage(source, 0, 0)
  return ctx2d.getImageData(0, 0, w, h)
}

export class HostSpriteAtlasRhi {
  private readonly rhi: RhiDevice
  private readonly packer: HostAtlasPacker
  // Private (exposed via rhiSampler()) so its RhiSampler type does not collide
  // with the IconAtlasGpu interface's optional WebGPU `sampler?: GPUSampler`
  // (#1261) — this twin carries the RHI half, not the WebGPU one.
  private readonly _sampler: RhiSampler

  /** The fixed page. Allocated lazily on first ensure() and then held for
   *  the atlas's life — NEVER recreated (bind-group identity invariant). */
  private texture: RhiTexture | null = null
  private _cachedView: RhiTextureView | null = null

  constructor(rhi: RhiDevice, registry: HostImageRegistry) {
    this.rhi = rhi
    this.packer = new HostAtlasPacker(registry)
    // Same sampling contract as the WebGPU atlas: linear so non-integer-scale
    // icons stay smooth (clamp-to-edge is the RHI backends' fixed wrap mode).
    this._sampler = rhi.createSampler({ mag: 'linear', min: 'linear', label: 'host-sprite-atlas' })
  }

  // Named `_ensureTexture` (not `ensure`) so it does not collide with the
  // IconAtlasGpu interface's now-optional public `ensure?()` (#1261) — this
  // WebGL2 twin satisfies the interface via the RHI half (rhiView/rhiSampler).
  private _ensureTexture(): RhiTexture {
    if (this.texture) return this.texture
    this.texture = this.rhi.createTexture({
      width: HOST_ATLAS_PAGE,
      height: HOST_ATLAS_PAGE,
      format: 'rgba8unorm',
      usage: ['sample', 'copy-dst'],
      label: 'host-sprite-atlas',
    })
    return this.texture
  }

  /** The page's RHI view, cached for the atlas's life (the page identity
   *  never changes) — the retained-icon batch bind group binds this. */
  rhiView(): RhiTextureView {
    if (this._cachedView) return this._cachedView
    this._cachedView = this.rhi.createView(this._ensureTexture())
    return this._cachedView
  }
  rhiSampler(): RhiSampler {
    return this._sampler
  }

  size(): { width: number; height: number } {
    return { width: HOST_ATLAS_PAGE, height: HOST_ATLAS_PAGE }
  }

  markDirty(): void {
    this.packer.markDirty()
  }

  /** Sprite metadata lookup. Runs a lazy dirty-gated sync() first so a
   *  just-added image is packed + uploaded before its first lookup. */
  get(name: string): SpriteInfo | undefined {
    this.sync()
    return this.packer.get(name)
  }

  // #1261 — SpriteMetadataSource load-state (mirrors HostSpriteAtlasGPU). A
  // host atlas is eager: images register synchronously, so it is always
  // 'loaded' and whenReady() resolves at once. Added so this WebGL2 twin
  // satisfies the full SpriteMetadataSource IconStage.forHostAtlas requires.
  getState(): { status: 'loaded' } {
    return { status: 'loaded' }
  }

  whenReady(): Promise<void> {
    return Promise.resolve()
  }

  /** Pack + region-upload every registry entry not yet in the atlas (shared
   *  HostAtlasPacker layout; RHI writeTexture region upload). */
  sync(): void {
    this.packer.sync((source, x, y, w, h) => {
      const data = isImageData(source) ? source : bitmapToImageData(source, w, h)
      if (data === null) {
        xlog.warn(
          '[X-GIS graphics] ImageBitmap upload needs a 2D canvas to decode on this backend — image skipped',
        )
        return
      }
      this.rhi.writeTexture(this._ensureTexture(), data.data, w * 4, w, h, x, y)
    })
  }

  destroy(): void {
    if (this.texture) this.rhi.destroyTexture(this.texture)
    this.rhi.destroySampler(this._sampler)
    this.texture = null
    this._cachedView = null
    this.packer.reset()
  }
}
