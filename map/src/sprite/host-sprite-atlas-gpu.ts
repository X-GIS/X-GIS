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
// The atlas LAYOUT (shelf packing + SpriteInfo metadata) lives in the shared
// HostAtlasPacker (#823) — the same packer the WebGL2-fallback
// HostSpriteAtlasRhi uses, so both backends pack identical coordinates by
// construction. This class owns only the WebGPU resources + region upload.
//
// Per-run (dies with the GPUDevice on a scene swap); the DEVICE-FREE
// HostImageRegistry it mirrors survives so host images outlive the atlas.

import {
  wrapWebGpuSampler,
  wrapWebGpuTextureView,
  type RhiSampler,
  type RhiTextureView,
} from '@xgis/engine'
import type { SpriteInfo } from './sprite-atlas-host'
import type { HostImageRegistry } from './host-image-registry'
import type { IconAtlasGpu, SpriteMetadataSource } from './icon-stage'
import { HostAtlasPacker, HOST_ATLAS_PAGE } from './host-atlas-packer'

/** Fixed single-page dimensions. rgba8unorm, matching SpriteAtlasGPU. */
const PAGE = HOST_ATLAS_PAGE

/** ImageData carries a `.data` byte array; ImageBitmap does not. Structural
 *  probe avoids `instanceof ImageData`, whose global is absent in non-DOM
 *  (test) environments. */
function isImageData(source: ImageBitmap | ImageData): source is ImageData {
  return 'data' in source
}

export class HostSpriteAtlasGPU implements IconAtlasGpu, SpriteMetadataSource {
  private readonly device: GPUDevice
  private readonly packer: HostAtlasPacker
  readonly sampler: GPUSampler

  /** The fixed page. Allocated lazily on first ensure() and then held for
   *  the atlas's life — NEVER recreated. */
  private texture: GPUTexture | null = null
  private _cachedView: GPUTextureView | null = null
  private _cachedViewTexture: GPUTexture | null = null

  constructor(device: GPUDevice, registry: HostImageRegistry) {
    this.device = device
    this.packer = new HostAtlasPacker(registry)
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

  /** The page view/sampler as backend-blind RHI handles — the retained-icon
   *  batch bind group binds through these, so GraphicsManager stays blind to
   *  which atlas twin (WebGPU / RHI-native) it holds (#823). */
  rhiView(): RhiTextureView {
    return wrapWebGpuTextureView(this.getView())
  }
  rhiSampler(): RhiSampler {
    return wrapWebGpuSampler(this.sampler)
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
    this.packer.markDirty()
  }

  /** Sprite metadata lookup. Runs a lazy dirty-gated sync() first so a
   *  just-added image is packed + uploaded before its first lookup. */
  get(name: string): SpriteInfo | undefined {
    this.sync()
    return this.packer.get(name)
  }

  /** Pack + region-upload every registry entry not yet in the atlas (the
   *  shared HostAtlasPacker owns the layout; this provides the WebGPU
   *  region upload). Cheap no-op when nothing changed. */
  sync(): void {
    // ensure() inside the callback — packer.sync early-returns when clean, so a
    // clean lookup allocates nothing (matches the pre-extraction dirty gate).
    this.packer.sync((source, x, y, w, h) => this.upload(this.ensure(), source, x, y, w, h))
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
    this.packer.reset()
  }
}
